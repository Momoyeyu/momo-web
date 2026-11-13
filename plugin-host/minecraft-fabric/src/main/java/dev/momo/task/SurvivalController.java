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
 private MinecraftClient client(){return MinecraftClient.getInstance();}
 private int foodSlot(){var p=client().player;for(int i=0;i<9;i++)if(p.getInventory().getStack(i).contains(DataComponentTypes.FOOD))return i;return -1;}
 public SurvivalPolicy.Mode choose(){
  var c=client();var p=c.player;
  if(p==null||c.world==null||!p.isAlive())return SurvivalPolicy.Mode.NONE;
  threat=c.world.getEntitiesByClass(HostileEntity.class,p.getBoundingBox().expand(4),e->e.isAlive()&&p.canSee(e)&&p.squaredDistanceTo(e)<16).stream().min(java.util.Comparator.comparingDouble(e->e.squaredDistanceTo(p))).orElse(null);
  boolean eating=p.isUsingItem()&&p.getActiveItem().contains(DataComponentTypes.FOOD);
  // A skill already eating owns its use lifecycle; do not cancel it to start the same action.
  if(mode==SurvivalPolicy.Mode.NONE&&eating)return SurvivalPolicy.Mode.NONE;
  boolean critical=p.isInLava()||p.getAir()<35||(p.isOnFire()&&p.getHealth()<8);
  return policy.choose(true,false,critical,p.getHealth(),p.getHungerManager().getFoodLevel(),foodSlot()>=0,eating,threat!=null);
 }
 public void drive(SurvivalPolicy.Mode desired){
  var c=client();var p=c.player;
  if(desired!=mode){var selectedThreat=threat;stop();threat=selectedThreat;mode=desired;savedSlot=p.getInventory().selectedSlot;ticks=0;escapeYaw=p.getYaw();}
  ticks++;
  switch(mode){
   case EAT -> {int slot=foodSlot();if(slot>=0){p.getInventory().selectedSlot=slot;c.options.useKey.setPressed(true);if(!p.isUsingItem()&&ticks%4==1)c.interactionManager.interactItem(p,Hand.MAIN_HAND);}}
   case DEFEND -> {
    if(threat==null)return;
    if(ticks==1)for(int i=0;i<9;i++)if(p.getInventory().getStack(i).getItem() instanceof SwordItem){p.getInventory().selectedSlot=i;break;}
    look(threat.getEyePos());
    if(p.canInteractWithEntity(threat,0)&&p.getAttackCooldownProgress(0)>=.95){c.options.useKey.setPressed(false);if(p.isUsingItem())c.interactionManager.stopUsingItem(p);c.interactionManager.attackEntity(p,threat);p.swingHand(Hand.MAIN_HAND);}
    else if(p.getOffHandStack().isOf(Items.SHIELD)){c.options.useKey.setPressed(true);if(!p.isUsingItem())c.interactionManager.interactItem(p,Hand.OFF_HAND);}
   }
   case ESCAPE -> {
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
 public void stop(){
  if(mode==SurvivalPolicy.Mode.NONE){threat=null;return;}
  var c=client();if(c.player!=null){if(c.player.isUsingItem()&&c.interactionManager!=null)c.interactionManager.stopUsingItem(c.player);if(savedSlot>=0)c.player.getInventory().selectedSlot=savedSlot;}
  c.options.forwardKey.setPressed(false);c.options.sprintKey.setPressed(false);c.options.jumpKey.setPressed(false);c.options.useKey.setPressed(false);
  savedSlot=-1;mode=SurvivalPolicy.Mode.NONE;threat=null;
 }
}
