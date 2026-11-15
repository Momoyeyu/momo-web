package dev.momo.task;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.hit.*;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;
/** Shared actual voxel-shape sight and face checks, never hidden-block discovery. */
final class BlockSight {
 private BlockSight(){}
 static BlockHitResult hit(MinecraftClient c,BlockPos target){return hit(c,target,null);}
 static BlockHitResult hit(MinecraftClient c,BlockPos target,Direction face){
  var eye=c.player.getEyePos();if(eye.squaredDistanceTo(target.toCenterPos())>1024)return null;
  var state=c.world.getBlockState(target);var shape=state.getCollisionShape(c.world,target);var type=RaycastContext.ShapeType.COLLIDER;
  if(shape.isEmpty()){shape=state.getOutlineShape(c.world,target);type=RaycastContext.ShapeType.OUTLINE;}
  for(var box:shape.getBoundingBoxes().stream().limit(16).toList()){
   var point=box.getCenter();
   if(face!=null)point=point.add(face.getOffsetX()*(box.maxX-box.minX)*.4999,face.getOffsetY()*(box.maxY-box.minY)*.4999,face.getOffsetZ()*(box.maxZ-box.minZ)*.4999);
   var ray=c.world.raycast(new RaycastContext(eye,point.add(target.getX(),target.getY(),target.getZ()),type,RaycastContext.FluidHandling.NONE,c.player));
   if(ray.getType()==HitResult.Type.BLOCK&&ray.getBlockPos().equals(target)&&(face==null||ray.getSide()==face))return ray;
  }return null;
 }
}
