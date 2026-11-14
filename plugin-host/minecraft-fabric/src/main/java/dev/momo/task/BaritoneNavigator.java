package dev.momo.task;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.Settings;
import java.util.LinkedHashMap;
import java.util.Map;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalXZ;
import baritone.api.pathing.goals.Goal;
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
  baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
  if(baritone.getPathingBehavior().isPathing()||baritone.getCustomGoalProcess().isActive()||(baritone.getPathingBehavior().getInProgress().isPresent()&&baritone!=releasedByUs))throw new IllegalStateException("Another navigator owns control");
  var config=BaritoneAPI.getSettings();
  override(config.allowBreak,false);override(config.allowPlace,false);
  override(config.allowParkourPlace,false);override(config.allowWaterBucketFall,false);
  override(config.chatControl,false);override(config.chatControlAnyway,false);override(config.prefixControl,false);
  override(config.freeLook,false);override(config.renderPath,false);override(config.renderGoal,false);
  override(config.chunkCaching,false);
  override(config.primaryTimeoutMS,Math.min(1000L,Math.max(1L,config.primaryTimeoutMS.value)));
  override(config.failureTimeoutMS,Math.min(3000L,Math.max(1L,config.failureTimeoutMS.value)));
  override(config.planAheadPrimaryTimeoutMS,Math.min(500L,Math.max(1L,config.planAheadPrimaryTimeoutMS.value)));
  override(config.planAheadFailureTimeoutMS,Math.min(1500L,Math.max(1L,config.planAheadFailureTimeoutMS.value)));
  goal=surface?new GoalXZ(x,z):new GoalNear(new BlockPos(x,y,z),precise?0:1);
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
