package dev.momo.task;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.hit.*;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;
/** Shared actual voxel-shape sight and face checks, never hidden-block discovery. */
final class BlockSight {
 private BlockSight(){}
 static boolean visibleAbsence(MinecraftClient c,BlockPos target){
  if(!c.world.isChunkLoaded(target))return false;
  var eye=c.player.getEyePos();
  return visibleAbsence(eye,target,end->c.world.raycast(new RaycastContext(eye,end,RaycastContext.ShapeType.OUTLINE,RaycastContext.FluidHandling.ANY,c.player)),()->c.world.getBlockState(target).isAir());
 }
 static boolean visibleAbsence(Vec3d eye,BlockPos target,java.util.function.Function<Vec3d,BlockHitResult> cast,java.util.function.BooleanSupplier air){
  // Only read the named cell after the entire sight segment is unobstructed.
  return eye.squaredDistanceTo(target.toCenterPos())<=1024&&cast.apply(target.toCenterPos()).getType()==HitResult.Type.MISS&&air.getAsBoolean();
 }
 static boolean visibleBuildCell(MinecraftClient c,BlockPos target){
  if(!c.world.isChunkLoaded(target))return false;
  var eye=c.player.getEyePos();
  return visibleBuildCell(eye,target,end->c.world.raycast(new RaycastContext(eye,end,RaycastContext.ShapeType.COLLIDER,RaycastContext.FluidHandling.ANY,c.player)),
    ()->c.world.getBlockState(target).isAir()||hit(c,target)!=null);
 }
 static boolean visibleBuildCell(Vec3d eye,BlockPos target,java.util.function.Function<Vec3d,BlockHitResult> cast,java.util.function.BooleanSupplier seenInOpenCell){
  var center=target.toCenterPos();
  if(eye.squaredDistanceTo(center)>1024)return false;
  var first=cast.apply(center);
  boolean checkedOpenCell=first.getType()==HitResult.Type.MISS;
  if(checkedOpenCell?seenInOpenCell.getAsBoolean():first.getBlockPos().equals(target))return true;
  for(var side:Direction.values()){
   var point=center.add(side.getOffsetX()*.499,side.getOffsetY()*.499,side.getOffsetZ()*.499);
   var ray=cast.apply(point);
   if(ray.getType()==HitResult.Type.BLOCK&&ray.getBlockPos().equals(target))return true;
   if(ray.getType()==HitResult.Type.MISS&&!checkedOpenCell){
    // Each endpoint is inside the target. A clear segment authorizes checking
    // for air or a visible non-colliding outline, never behind an obstruction.
    checkedOpenCell=true;
    if(seenInOpenCell.getAsBoolean())return true;
   }
  }
  return false;
 }
 static BlockHitResult hit(MinecraftClient c,BlockPos target){return hit(c,target,null);}
 static BlockHitResult hit(MinecraftClient c,BlockPos target,Direction face){
  return hit(c,target,face,null);
 }
 static BlockHitResult hit(MinecraftClient c,BlockPos target,Direction face,Vec3d observedPoint){
  var eye=c.player.getEyePos();if(eye.squaredDistanceTo(target.toCenterPos())>1024)return null;
  var state=c.world.getBlockState(target);var shape=state.getCollisionShape(c.world,target);var type=RaycastContext.ShapeType.COLLIDER;
  if(shape.isEmpty()){shape=state.getOutlineShape(c.world,target);type=RaycastContext.ShapeType.OUTLINE;}
  var rayType=type;
  return hit(eye,target,shape.getBoundingBoxes(),face,end->c.world.raycast(new RaycastContext(eye,end,rayType,RaycastContext.FluidHandling.NONE,c.player)),observedPoint);
 }
 static BlockHitResult hit(Vec3d eye,BlockPos target,java.util.List<Box> boxes,Direction face,java.util.function.Function<Vec3d,BlockHitResult> cast){
  return hit(eye,target,boxes,face,cast,null);
 }
 static BlockHitResult hit(Vec3d eye,BlockPos target,java.util.List<Box> boxes,Direction face,java.util.function.Function<Vec3d,BlockHitResult> cast,Vec3d observedPoint){
  // A discovery ray can see a corner that canonical face samples miss. This is
  // only an aiming hint: cast again from the CURRENT eye and require first hit.
  if(observedPoint!=null&&Double.isFinite(observedPoint.x)&&Double.isFinite(observedPoint.y)&&Double.isFinite(observedPoint.z)
    &&observedPoint.x>=target.getX()-.001&&observedPoint.x<=target.getX()+1.001
    &&observedPoint.y>=target.getY()-.001&&observedPoint.y<=target.getY()+1.001
    &&observedPoint.z>=target.getZ()-.001&&observedPoint.z<=target.getZ()+1.001){
   var end=observedPoint.add(observedPoint.subtract(eye).normalize().multiply(.001));
   var ray=cast.apply(end);
   if(ray.getType()==HitResult.Type.BLOCK&&ray.getBlockPos().equals(target)&&(face==null||ray.getSide()==face))return ray;
  }
  for(var box:boxes.stream().limit(16).toList()){
   var points=new java.util.ArrayList<Vec3d>();
   if(face==null)points.add(box.getCenter());
   for(var side:face==null?Direction.values():new Direction[]{face})points.add(box.getCenter().add(side.getOffsetX()*(box.maxX-box.minX)*.4999,side.getOffsetY()*(box.maxY-box.minY)*.4999,side.getOffsetZ()*(box.maxZ-box.minZ)*.4999));
   for(var point:points){
    var ray=cast.apply(point.add(target.getX(),target.getY(),target.getZ()));
    if(ray.getType()==HitResult.Type.BLOCK&&ray.getBlockPos().equals(target)&&(face==null||ray.getSide()==face))return ray;
   }
  }return null;
 }
}
