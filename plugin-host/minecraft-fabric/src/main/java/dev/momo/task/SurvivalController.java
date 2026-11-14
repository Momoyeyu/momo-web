package dev.momo.task;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.item.*;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.util.Hand;
import net.minecraft.util.math.*;

/** Borrows the single body's input after its current skill is paused. */
public final class SurvivalController {
 private final SurvivalPolicy policy=new SurvivalPolicy();
 private SurvivalPolicy.Mode mode=SurvivalPolicy.Mode.NONE;
 private HostileEntity threat;private int savedSlot=-1,ticks;private float escapeYaw;private boolean escapeSafe;
 private TaskRuntime.Work foodWork;private long foodRetryUntil;
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
  threat=c.world.getEntitiesByClass(HostileEntity.class,p.getBoundingBox().expand(4),e->e.isAlive()&&p.canSee(e)&&p.squaredDistanceTo(e)<16).stream().min(java.util.Comparator.comparingDouble(e->e.squaredDistanceTo(p))).orElse(null);
  boolean eating=foodWork!=null||(p.isUsingItem()&&p.getActiveItem().contains(DataComponentTypes.FOOD));
  boolean critical=p.isInLava()||policy.airCritical(p.getAir(),mode==SurvivalPolicy.Mode.ESCAPE)||(p.isOnFire()&&p.getHealth()<8);
  var desired=policy.choose(true,false,critical,p.getHealth(),p.getHungerManager().getFoodLevel(),foodWork!=null||(System.nanoTime()>=foodRetryUntil&&foodSlot()>=0),eating,threat!=null);
  return policy.forBody(desired,mealOwned||(mode==SurvivalPolicy.Mode.NONE&&eating),combatOwned);
 }
 public void drive(SurvivalPolicy.Mode desired){
  var c=client();var p=c.player;
  if(desired!=mode){var selectedThreat=threat;stop();threat=selectedThreat;mode=desired;savedSlot=p.getInventory().selectedSlot;ticks=0;escapeYaw=p.getYaw();}
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
    if(ticks==1)for(int i=0;i<9;i++)if(p.getInventory().getStack(i).getItem() instanceof SwordItem){p.getInventory().selectedSlot=i;break;}
    look(threat.getEyePos());
    var ahead=BlockPos.ofFloored(p.getX()-Math.sin(Math.toRadians(p.getYaw())),p.getY(),p.getZ()+Math.cos(Math.toRadians(p.getYaw())));
    boolean canClose=!p.canInteractWithEntity(threat,0)&&c.world.isChunkLoaded(ahead)&&c.world.getBlockState(ahead).getCollisionShape(c.world,ahead).isEmpty()&&c.world.getBlockState(ahead.down()).isSolidBlock(c.world,ahead.down())&&!c.world.getFluidState(ahead).isIn(net.minecraft.registry.tag.FluidTags.LAVA);
    c.options.forwardKey.setPressed(canClose);c.options.jumpKey.setPressed(canClose&&p.horizontalCollision);
    if(p.canInteractWithEntity(threat,0)&&p.getAttackCooldownProgress(0)>=.95){c.options.useKey.setPressed(false);if(p.isUsingItem())c.interactionManager.stopUsingItem(p);c.interactionManager.attackEntity(p,threat);p.swingHand(Hand.MAIN_HAND);}
    else if(p.getOffHandStack().isOf(Items.SHIELD)){c.options.useKey.setPressed(true);if(!p.isUsingItem())c.interactionManager.interactItem(p,Hand.OFF_HAND);}
   }
   case ESCAPE -> {
    p.setPitch(policy.escapePitch(p.isTouchingWater()&&p.getAir()<250,p.getPitch()));
    // Evaluate a few nearby collision cells, never hidden resources or global terrain.
    if(ticks==1||ticks%20==0){double best=-Double.MAX_VALUE;escapeSafe=false;for(int i=0;i<8;i++){
     float yaw=p.getYaw()+i*45;double angle=Math.toRadians(yaw);var pos=BlockPos.ofFloored(p.getX()-Math.sin(angle)*2,p.getY(),p.getZ()+Math.cos(angle)*2);
     if(!c.world.isChunkLoaded(pos)||!c.world.getBlockState(pos).getCollisionShape(c.world,pos).isEmpty()||c.world.getFluidState(pos).isIn(net.minecraft.registry.tag.FluidTags.LAVA))continue;
     if(!c.world.getBlockState(pos.down()).isSolidBlock(c.world,pos.down())&&!p.isTouchingWater()&&!p.isInLava())continue;
     double score=threat==null?0:pos.toCenterPos().squaredDistanceTo(threat.getPos());if(c.world.getFluidState(pos).isIn(net.minecraft.registry.tag.FluidTags.WATER))score+=100;
     if(score>best){best=score;escapeYaw=yaw;escapeSafe=true;}
    }}
    p.setYaw(escapeYaw);c.options.forwardKey.setPressed(escapeSafe);c.options.sprintKey.setPressed(true);c.options.jumpKey.setPressed(p.isTouchingWater()||p.isInLava()||p.horizontalCollision);
   }
   default -> {}
  }
 }
 private void look(Vec3d target){var p=client().player;var d=target.subtract(p.getEyePos());float yaw=(float)Math.toDegrees(Math.atan2(-d.x,d.z));p.setYaw(p.getYaw()+MathHelper.clamp(MathHelper.wrapDegrees(yaw-p.getYaw()),-20,20));p.setPitch((float)-Math.toDegrees(Math.atan2(d.y,Math.sqrt(d.x*d.x+d.z*d.z))));}
 public void stop(){stop(false);}
 public void stop(boolean preserveScreen){
  var c=client();boolean mealScreen=acceptsScreen(c.currentScreen);
  if(foodWork!=null){foodWork.stop();foodWork=null;}
  if(!preserveScreen&&mealScreen&&c.player!=null&&c.player.currentScreenHandler.getCursorStack().isEmpty())c.player.closeHandledScreen();
  if(mode==SurvivalPolicy.Mode.NONE){threat=null;return;}
  if(c.player!=null){if(c.player.isUsingItem()&&c.interactionManager!=null)c.interactionManager.stopUsingItem(c.player);if(savedSlot>=0)c.player.getInventory().selectedSlot=savedSlot;}
  c.options.forwardKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.useKey.setPressed(false);
  savedSlot=-1;mode=SurvivalPolicy.Mode.NONE;threat=null;
 }
}
