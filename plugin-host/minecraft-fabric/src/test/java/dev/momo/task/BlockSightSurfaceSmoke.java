package dev.momo.task;
import java.util.List;
import net.minecraft.util.math.*;
import net.minecraft.util.hit.*;
/** Visible floor faces cannot be rejected just because their centers lie below the surface. */
final class BlockSightSurfaceSmoke {
 public static void main(String[] args){
  var eye=new Vec3d(.5,2.62,.5);var target=new BlockPos(3,0,0);
  java.util.function.Function<Vec3d,BlockHitResult> floor=end->{
   double t=(eye.y-1)/(eye.y-end.y);var point=eye.add(end.subtract(eye).multiply(t));
   return new BlockHitResult(point,Direction.UP,new BlockPos((int)Math.floor(point.x),0,(int)Math.floor(point.z)),false);
  };
  var boxes=List.of(new Box(0,0,0,1,1,1));
  var hit=BlockSight.hit(eye,target,boxes,null,floor);
  if(hit==null||!hit.getBlockPos().equals(target)||hit.getSide()!=Direction.UP)throw new AssertionError("A visible far floor tile needs a top-face sight sample, not only its occluded center");
  if(BlockSight.hit(eye,target,boxes,Direction.DOWN,floor)!=null)throw new AssertionError("Seeing the top never authorizes an occluded requested bottom face");
 }
}
