package dev.momo.task;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.*;
import net.minecraft.item.*;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.util.math.*;

/** Borrows the single body's input after its current skill is paused. */
public final class SurvivalController {
 private final SurvivalPolicy policy=new SurvivalPolicy();
 private SurvivalPolicy.Mode mode=SurvivalPolicy.Mode.NONE;
 private Vec3d threatPosition;
 private LivingEntity threat;private int savedSlot=-1,ticks;private float escapeYaw;private boolean escapeSafe,combatRetreat;
 private TaskRuntime.Work foodWork,combatWork;private long foodRetryUntil,combatRetryUntil;private String replanReason="";
 private CombatWithdrawal withdrawal=new CombatWithdrawal();
 private final BlastAvoidance blasts=new BlastAvoidance();
 private MinecraftClient client(){return MinecraftClient.getInstance();}
 public boolean interruptOwnedScreen(SurvivalPolicy.Mode desired,boolean owned){return policy.interruptOwnedScreen(desired,owned);}
 public boolean acceptsScreen(Object screen){return screen!=null&&foodWork!=null&&foodWork.acceptsScreen(screen);}
 public boolean canDrive(boolean paused,boolean focused,Object screen){return policy.canDrive(paused,focused,screen!=null,acceptsScreen(screen));}
 private int foodSlot(){return FoodInventory.find(client(),36);}
 public SurvivalPolicy.Mode choose(){
  return choose(false,false);
 }
 public SurvivalPolicy.Mode choose(boolean combatOwned,boolean mealOwned){
  var c=client();var p=c.player;
  if(p==null||c.world==null||!p.isAlive())return SurvivalPolicy.Mode.NONE;
  blasts.update(p.getX(),p.getY(),p.getZ(),c.world.getEntitiesByClass(CreeperEntity.class,p.getBoundingBox().expand(16),e->e.isAlive()&&p.canSee(e)).stream()
    .map(e->new BlastAvoidance.Creeper(e.getId(),e.getX(),e.getY(),e.getZ(),true,e.getFuseSpeed()>0||e.getClientFuseTime(0)>0,e.shouldRenderOverlay())).toList());
  // Preserve one borrowed combat owner while it pursues/briefly reacquires its
  // visible target; do not swap enemies every tick or attack calm neutrals.
  if(combatWork==null&&!combatRetreat||threat==null||!threat.isAlive()||threatPosition==null||p.squaredDistanceTo(threatPosition)>1024){
   threat=c.world.getEntitiesByClass(LivingEntity.class,p.getBoundingBox().expand(32),e->{
    if(e==p||!e.isAlive()||!p.canSee(e))return false;
    if(e instanceof CreeperEntity&&p.squaredDistanceTo(e)>16)return false; // Do not chase a defused creeper back into fuse range.
    var damage=p.getRecentDamageSource();
    boolean recent=ThreatPolicy.recent(p.getAttacker()==e,p.age-p.getLastAttackedTime(),damage!=null&&damage.getAttacker()==e);
    boolean neutral=e instanceof EndermanEntity||e instanceof PiglinEntity||e instanceof ZombifiedPiglinEntity||e instanceof SpiderEntity&&c.world.isDay();
    boolean aggressive=e instanceof MobEntity mob&&(mob.isAttacking()||mob.getTarget()==p)||e instanceof EndermanEntity enderman&&enderman.isAngry();
    boolean ranged=e instanceof net.minecraft.entity.ai.RangedAttackMob||e instanceof GhastEntity||e instanceof BlazeEntity||e instanceof GuardianEntity;
    return ThreatPolicy.danger(true,e instanceof Monster,neutral,aggressive,recent,ranged,p.squaredDistanceTo(e));
   }).stream().min(java.util.Comparator.comparingDouble(e->e.squaredDistanceTo(p))).orElse(null);
  }
  if(threat==null)threatPosition=null;else if(p.canSee(threat))threatPosition=threat.getPos();
  boolean eating=foodWork!=null||(p.isUsingItem()&&p.getActiveItem().contains(DataComponentTypes.FOOD));
  boolean critical=blasts.active()||p.isInLava()||policy.airCritical(p.getAir(),mode==SurvivalPolicy.Mode.ESCAPE)||(p.isOnFire()&&p.getHealth()<8);
  var desired=policy.choose(true,false,critical,p.getHealth(),p.getHungerManager().getFoodLevel(),foodWork!=null||(System.nanoTime()>=foodRetryUntil&&foodSlot()>=0),eating,threat!=null);
  desired=policy.forBody(desired,mealOwned||(mode==SurvivalPolicy.Mode.NONE&&eating),combatOwned);
  if(desired==SurvivalPolicy.Mode.DEFEND&&System.nanoTime()<combatRetryUntil)desired=SurvivalPolicy.Mode.NONE;
  if(mode==SurvivalPolicy.Mode.ESCAPE&&combatRetreat&&!critical){
   String retreat=threat==null||!threat.isAlive()?"retreated_low_health":withdrawal.update(p.getHealth(),p.squaredDistanceTo(threatPosition),ticks);
   if(retreat.equals("retreating"))desired=SurvivalPolicy.Mode.ESCAPE;
   else{replanReason=retreat;desired=SurvivalPolicy.Mode.NONE;}
  }
  return desired;
 }
 public String replanReason(){return replanReason;}
 public java.util.Map<String,Object> progress(){
  var result=new java.util.LinkedHashMap<String,Object>();result.put("mode",mode.name().toLowerCase(java.util.Locale.ROOT));result.put("ticks",ticks);
  if(threat!=null)result.put("entityId",threat.getId());
  if(combatWork!=null)result.put("action",combatWork.progress());
  if(blasts.active())result.put("avoidingBlast",true);
  return java.util.Map.copyOf(result);
 }
 public void drive(SurvivalPolicy.Mode desired){
  var c=client();var p=c.player;
  if(desired!=mode){var selectedThreat=threat;var selectedPosition=threatPosition;stop(false,true);threat=selectedThreat;threatPosition=selectedPosition;mode=desired;savedSlot=p.getInventory().selectedSlot;ticks=0;escapeYaw=p.getYaw();combatRetreat=desired==SurvivalPolicy.Mode.ESCAPE&&p.getHealth()<=6&&threat!=null;if(combatRetreat)withdrawal.update(p.getHealth(),p.squaredDistanceTo(threatPosition),ticks);}
  ticks++;
  switch(mode){
   case EAT -> {
    try{
     if(foodWork==null){foodWork=GameSkills.create("eat",new com.google.gson.JsonObject());foodWork.start();}
     var result=foodWork.tick();
     if(!result.state().equals("running")){if(!result.state().equals("succeeded"))foodRetryUntil=System.nanoTime()+5_000_000_000L;stop();}
    }catch(RuntimeException error){foodRetryUntil=System.nanoTime()+5_000_000_000L;stop();}
   }
   case DEFEND -> {
    if(threat==null)return;
    try{
     if(combatWork==null){
      for(int i=0;i<9;i++)if(p.getInventory().getStack(i).getItem() instanceof SwordItem){p.getInventory().selectedSlot=i;break;}
      var args=new com.google.gson.JsonObject();args.addProperty("entityId",threat.getId());combatWork=GameSkills.create("attack",args);combatWork.start();
     }
     var result=combatWork.tick();
     if(!result.state().equals("running")){boolean failed=!result.state().equals("succeeded");stop();if(failed){replanReason="defense_blocked";combatRetryUntil=System.nanoTime()+5_000_000_000L;}}
    }catch(RuntimeException error){stop();replanReason="defense_blocked";combatRetryUntil=System.nanoTime()+5_000_000_000L;}
   }
   case ESCAPE -> {
    p.setPitch(policy.escapePitch(p.isTouchingWater()&&p.getAir()<250,p.getPitch()));
    // Evaluate a few nearby collision cells, never hidden resources or global terrain.
    if(ticks==1||ticks%(blasts.active()?4:20)==0){double best=-Double.MAX_VALUE;escapeSafe=false;for(int i=0;i<8;i++){
     float yaw=p.getYaw()+i*45;double angle=Math.toRadians(yaw);var pos=BlockPos.ofFloored(p.getX()-Math.sin(angle)*2,p.getY(),p.getZ()+Math.cos(angle)*2);
     if(!c.world.isChunkLoaded(pos)||!c.world.getBlockState(pos).getCollisionShape(c.world,pos).isEmpty()||c.world.getFluidState(pos).isIn(net.minecraft.registry.tag.FluidTags.LAVA))continue;
     if(!c.world.getBlockState(pos.down()).isSolidBlock(c.world,pos.down())&&!p.isTouchingWater()&&!p.isInLava())continue;
     var point=pos.toCenterPos();
     double score=blasts.active()?blasts.score(point.x,point.y,point.z):threat==null?0:point.squaredDistanceTo(threatPosition);
     if(!blasts.active()&&c.world.getFluidState(pos).isIn(net.minecraft.registry.tag.FluidTags.WATER))score+=100;
     if(score>best){best=score;escapeYaw=yaw;escapeSafe=true;}
    }}
    p.setYaw(escapeYaw);c.options.forwardKey.setPressed(escapeSafe);c.options.sprintKey.setPressed(true);c.options.jumpKey.setPressed(p.isTouchingWater()||p.isInLava()||p.horizontalCollision);
   }
   default -> {}
  }
 }
 public void stop(){stop(false);}
 public void stop(boolean preserveScreen){stop(preserveScreen,false);}
 private void stop(boolean preserveScreen,boolean preserveBlast){
  if(!preserveBlast)blasts.clear();
  var c=client();boolean mealScreen=acceptsScreen(c.currentScreen);
  if(foodWork!=null){foodWork.stop();foodWork=null;}
  if(combatWork!=null){combatWork.stop();combatWork=null;}
  if(!preserveScreen&&mealScreen&&c.player!=null&&c.player.currentScreenHandler.getCursorStack().isEmpty())c.player.closeHandledScreen();
  threatPosition=null;combatRetreat=false;withdrawal=new CombatWithdrawal();replanReason="";
  if(mode==SurvivalPolicy.Mode.NONE){threat=null;return;}
  if(c.player!=null){if(c.player.isUsingItem()&&c.interactionManager!=null)c.interactionManager.stopUsingItem(c.player);if(savedSlot>=0)c.player.getInventory().selectedSlot=savedSlot;}
  c.options.forwardKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.useKey.setPressed(false);
  savedSlot=-1;mode=SurvivalPolicy.Mode.NONE;threat=null;
 }
}
