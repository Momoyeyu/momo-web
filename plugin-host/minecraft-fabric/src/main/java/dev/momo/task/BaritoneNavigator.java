package dev.momo.task;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.Settings;
import java.util.LinkedHashMap;
import java.util.Map;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.GoalComposite;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;

/** API-only ownership. Discovery/mining scans and arbitrary Baritone commands are not exposed. */
public final class BaritoneNavigator {
 private IBaritone baritone;
 private Goal goal;
 private int warmup,pendingTicks;
 private boolean started,pending;
 private static IBaritone releasedByUs;
 private final Map<Settings.Setting<?>,Runnable> settings=new LinkedHashMap<>();
 private <T> void override(Settings.Setting<T> setting,T value){T previous=setting.value;settings.putIfAbsent(setting,()->setting.value=previous);setting.value=value;}
 public void start(int x,int y,int z){
  start(x,y,z,false);
 }
 public void start(int x,int y,int z,boolean surface){
  start(x,y,z,surface,false);
 }
 public void start(int x,int y,int z,boolean surface,boolean precise){
  start(x,y,z,surface,precise,false);
 }
 public void start(int x,int y,int z,boolean surface,boolean precise,boolean adaptTerrain){
  startGoal(surface?new GoalXZ(x,z):new GoalNear(new BlockPos(x,y,z),precise?0:1),adaptTerrain);
 }
 public void startInteraction(BlockPos target){startGoal(interactionGoal(target),false);}
 private Goal interactionGoal(BlockPos target){
  var c=MinecraftClient.getInstance();var world=c.world;var player=c.player;
  if(world==null||player==null)throw new TaskRuntime.Rejected("world_unavailable");
  var state=world.getBlockState(target);var shape=state.getCollisionShape(world,target);var rayType=net.minecraft.world.RaycastContext.ShapeType.COLLIDER;
  if(shape.isEmpty()){shape=state.getOutlineShape(world,target);rayType=net.minecraft.world.RaycastContext.ShapeType.OUTLINE;}
  if(shape.isEmpty())throw new TaskRuntime.Rejected("target_not_visible");
  var point=shape.getBoundingBoxes().getFirst().getCenter().add(target.getX(),target.getY(),target.getZ());
  double eyeHeight=player.getStandingEyeHeight(),reach=Math.max(1,player.getBlockInteractionRange()-.25);
  var goals=new java.util.ArrayList<Goal>();int rays=0;
  for(var candidate:InteractionReach.candidates(target.getX(),target.getY(),target.getZ(),player.getX(),player.getY(),player.getZ(),eyeHeight,reach)){
   var feet=new BlockPos(candidate.x(),candidate.y(),candidate.z());if(!world.isChunkLoaded(feet))continue;
   for(var support:new BlockPos[]{feet.down(),feet}){
    var floor=world.getBlockState(support).getCollisionShape(world,support);if(floor.isEmpty())continue;
    double y=support.getY()+floor.getMax(net.minecraft.util.math.Direction.Axis.Y);if(Math.floor(y)!=feet.getY())continue;
    var position=new net.minecraft.util.math.Vec3d(feet.getX()+.5,y,feet.getZ()+.5);var eye=position.add(0,eyeHeight,0);
    if(state.getBlock() instanceof net.minecraft.block.BedBlock&&!InteractionReach.bedApproach(position.x,position.y,position.z,target.getX(),target.getY(),target.getZ()))continue;
    if(eye.squaredDistanceTo(point)>reach*reach||!world.isSpaceEmpty(player,player.getDimensions(net.minecraft.entity.EntityPose.STANDING).getBoxAt(position)))continue;
    var hit=world.raycast(new net.minecraft.world.RaycastContext(eye,point,rayType,net.minecraft.world.RaycastContext.FluidHandling.NONE,player));rays++;
    if(hit.getType()==net.minecraft.util.hit.HitResult.Type.BLOCK&&hit.getBlockPos().equals(target))goals.add(new GoalBlock(feet));
    break;
   }
   if(rays>=16)break;
  }
  if(goals.isEmpty())throw new TaskRuntime.Rejected("unreachable");
  return new GoalComposite(goals.toArray(Goal[]::new));
 }
 private void startGoal(Goal requested,boolean adaptTerrain){
  baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
  if(baritone.getPathingBehavior().isPathing()||baritone.getCustomGoalProcess().isActive()||(baritone.getPathingBehavior().getInProgress().isPresent()&&baritone!=releasedByUs))throw new IllegalStateException("Another navigator owns control");
  var config=BaritoneAPI.getSettings();
  override(config.allowBreak,adaptTerrain);override(config.allowPlace,adaptTerrain);
  override(config.allowParkourPlace,false);override(config.allowWaterBucketFall,false);
  override(config.chatControl,false);override(config.chatControlAnyway,false);override(config.prefixControl,false);
  override(config.freeLook,false);override(config.renderPath,false);override(config.renderGoal,false);
  override(config.chunkCaching,false);
  override(config.primaryTimeoutMS,Math.min(1000L,Math.max(1L,config.primaryTimeoutMS.value)));
  override(config.failureTimeoutMS,Math.min(3000L,Math.max(1L,config.failureTimeoutMS.value)));
  override(config.planAheadPrimaryTimeoutMS,Math.min(500L,Math.max(1L,config.planAheadPrimaryTimeoutMS.value)));
  override(config.planAheadFailureTimeoutMS,Math.min(1500L,Math.max(1L,config.planAheadFailureTimeoutMS.value)));
  goal=requested;
  warmup=4;
  pendingTicks=0;started=false;pending=baritone.getPathingBehavior().getInProgress().isPresent();
  if(!pending)begin();
 }
 private void begin(){baritone.getCustomGoalProcess().setGoalAndPath(goal);started=true;pending=false;warmup=4;}
 public void stop(){
  if(baritone!=null&&goal!=null&&started){baritone.getCustomGoalProcess().setGoal(null);baritone.getPathingBehavior().cancelEverything();baritone.getInputOverrideHandler().clearAllKeys();releasedByUs=baritone;}
  goal=null;pending=started=false;
  settings.values().forEach(Runnable::run);settings.clear();
 }
 public boolean arrived(){
  var client=MinecraftClient.getInstance();
  return goal!=null&&client.player!=null&&goal.isInGoal(client.player.getBlockPos());
 }
 public boolean failed(){
  if(pending){if(++pendingTicks>20)return true;if(!baritone.getPathingBehavior().getInProgress().isPresent()&&!baritone.getPathingBehavior().isPathing()&&!baritone.getCustomGoalProcess().isActive())begin();return false;}
  if(warmup-->0)return false;
  return baritone!=null&&!baritone.getCustomGoalProcess().isActive()&&!baritone.getPathingBehavior().isPathing();
 }
 public static boolean available(){return BaritoneAPI.getProvider().getPrimaryBaritone()!=null;}
}
