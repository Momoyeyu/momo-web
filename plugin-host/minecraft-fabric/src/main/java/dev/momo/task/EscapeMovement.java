package dev.momo.task;
import java.util.*;
import java.util.function.ToDoubleFunction;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.EntityPose;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.state.property.Properties;
import net.minecraft.util.math.*;
/** Shared local motor for reflex and explicit retreat, under the existing body owner. */
final class EscapeMovement {
 private final SurvivalPolicy policy=new SurvivalPolicy();
 private Object world;private int plannedAt;private boolean planned;private double ground=Double.NaN;
 private Optional<EscapeRoute.Choice> choice=Optional.empty();
 void reset(){world=null;planned=false;ground=Double.NaN;choice=Optional.empty();}
 void drive(MinecraftClient c,ToDoubleFunction<Vec3d> score){
  var p=c.player;
  if(world!=c.world){reset();world=c.world;}
  boolean fluid=p.isTouchingWater()||p.isInLava();
  p.setPitch(policy.escapePitch(p.isTouchingWater()&&p.getAir()<250,p.getPitch()));
  if(p.isOnGround()||fluid||!Double.isFinite(ground))ground=p.getY();
  if(!planned||p.age<plannedAt||p.age-plannedAt>=4){
   planned=true;plannedAt=p.age;
   var body=p.getDimensions(EntityPose.STANDING).getBoxAt(p.getPos());
   choice=EscapeRoute.choose(body,ground,p.getYaw(),fluid,new EscapeRoute.Scene(){
    public boolean known(Box area){
     if(area.minY<c.world.getBottomY()||area.maxY>c.world.getTopY())return false;
     int minX=MathHelper.floor(area.minX),maxX=MathHelper.floor(area.maxX-1e-7),minZ=MathHelper.floor(area.minZ),maxZ=MathHelper.floor(area.maxZ-1e-7);
     for(int x=minX>>4;x<=maxX>>4;x++)for(int z=minZ>>4;z<=maxZ>>4;z++)if(!c.world.isChunkLoaded(new BlockPos(x<<4,p.getBlockY(),z<<4)))return false;
     return c.world.getWorldBorder().contains(new BlockPos(minX,p.getBlockY(),minZ))&&c.world.getWorldBorder().contains(new BlockPos(maxX,p.getBlockY(),maxZ));
    }
    public List<Box> collisions(Box area){
     var result=new ArrayList<Box>();for(var shape:c.world.getBlockCollisions(p,area))result.addAll(shape.getBoundingBoxes());return result;
    }
    public boolean dangerous(Box area){
     for(var pos:BlockPos.iterate(MathHelper.floor(area.minX),MathHelper.floor(area.minY),MathHelper.floor(area.minZ),MathHelper.floor(area.maxX-1e-7),MathHelper.floor(area.maxY-1e-7),MathHelper.floor(area.maxZ-1e-7))){
      var state=c.world.getBlockState(pos);
      if(state.getFluidState().isIn(FluidTags.LAVA)||state.isOf(Blocks.FIRE)||state.isOf(Blocks.SOUL_FIRE)||state.isOf(Blocks.CACTUS)||state.isOf(Blocks.MAGMA_BLOCK)||state.isOf(Blocks.WITHER_ROSE)||state.isOf(Blocks.POWDER_SNOW)||state.isOf(Blocks.SWEET_BERRY_BUSH))return true;
      if((state.isOf(Blocks.CAMPFIRE)||state.isOf(Blocks.SOUL_CAMPFIRE))&&state.get(Properties.LIT))return true;
     }
     return false;
    }
   },score);
  }
  choice.ifPresent(route->p.setYaw(route.yaw()));
  c.options.forwardKey.setPressed(choice.isPresent());c.options.backKey.setPressed(false);
  c.options.leftKey.setPressed(false);c.options.rightKey.setPressed(false);c.options.sprintKey.setPressed(choice.isPresent());
  c.options.sneakKey.setPressed(false);
  c.options.jumpKey.setPressed(fluid||choice.isPresent()&&(choice.get().jump()||p.horizontalCollision));
 }
}
