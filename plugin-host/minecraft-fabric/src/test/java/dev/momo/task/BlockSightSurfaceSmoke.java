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
  var reads=new java.util.concurrent.atomic.AtomicInteger();
  java.util.function.BooleanSupplier air=()->{reads.incrementAndGet();return true;};
  if(BlockSight.visibleAbsence(eye,target,floor,air)||reads.get()!=0)throw new AssertionError("An occluding hit must prevent even reading a hidden target state");
  java.util.function.Function<Vec3d,BlockHitResult> clear=end->BlockHitResult.createMissed(end,Direction.UP,target);
  if(!BlockSight.visibleAbsence(eye,target,clear,air)||reads.get()!=1)throw new AssertionError("A clear visible empty cell can invalidate a past sighting");
  if(BlockSight.visibleAbsence(eye,new BlockPos(100,0,0),clear,air)||reads.get()!=1)throw new AssertionError("Do not inspect out-of-range coordinates");
  if(BlockSight.visibleAbsence(eye,target,clear,()->false))throw new AssertionError("A partial non-air shape must never be invented as absent");
  // A thin natural gap can expose a real log corner while all seven canonical
  // center/face samples are blocked. Preserve the actual discovery ray.
  var cornerEye=new Vec3d(0,1,.5);var corner=new BlockPos(3,0,0);
  java.util.function.Function<Vec3d,BlockHitResult> gap=end->{
   var ray=end.subtract(cornerEye);var wall=cornerEye.add(ray.multiply(2.5/ray.x));
   if(wall.y>.86&&wall.y<.88&&wall.z>.22&&wall.z<.24){
    var point=cornerEye.add(ray.multiply(3/ray.x));
    return new BlockHitResult(point,Direction.WEST,corner,false);
   }
   return new BlockHitResult(wall,Direction.WEST,new BlockPos(2,0,0),false);
  };
  var seen=new Vec3d(3.0001,.84,.18);
  if(BlockSight.hit(cornerEye,corner,boxes,null,gap)!=null)throw new AssertionError("Fixture must expose only the off-center gap");
  var known=BlockSight.hit(cornerEye,corner,boxes,null,gap,seen);
  if(known==null||!known.getBlockPos().equals(corner))throw new AssertionError("An actually observed corner must survive handoff to mining");
  java.util.function.Function<Vec3d,BlockHitResult> closed=end->new BlockHitResult(new Vec3d(2.5,.87,.23),Direction.WEST,new BlockPos(2,0,0),false);
  if(BlockSight.hit(cornerEye,corner,boxes,null,closed,seen)!=null)throw new AssertionError("Past sight never bypasses new occlusion");
  if(BlockSight.hit(cornerEye,corner,boxes,Direction.UP,gap,seen)!=null)throw new AssertionError("A west-face discovery cannot authorize the top face");

  var roofEye=new Vec3d(.5,1.5,-3);
  var roofCell=new BlockPos(0,1,0);
  var nearWall=new BlockPos(0,1,-1);
  var partialWall=new Box(0,1,-1,.72,2,0);
  java.util.function.Function<Vec3d,BlockHitResult> roof=end->partialWall.raycast(roofEye,end)
    .map(point->new BlockHitResult(point,Direction.NORTH,nearWall,false))
    .orElseGet(()->BlockHitResult.createMissed(end,Direction.NORTH,roofCell));
  if(roof.apply(roofCell.toCenterPos()).getType()!=HitResult.Type.BLOCK)throw new AssertionError("Roof regression needs an occluded center");
  if(!BlockSight.visibleBuildCell(roofEye,roofCell,roof,()->true))throw new AssertionError("An unobstructed face sample can prove the empty roof cell is visible");
  if(BlockSight.visibleBuildCell(roofEye,roofCell,roof,()->false))throw new AssertionError("A clear path into a cell cannot prove an unseen solid");
  if(BlockSight.visibleBuildCell(roofEye,roofCell,end->new BlockHitResult(end,Direction.NORTH,nearWall,false),()->{throw new AssertionError("Hidden state read");}))throw new AssertionError("A completely occluded roof remains ineligible");
  if(!BlockSight.visibleBuildCell(roofEye,roofCell,end->new BlockHitResult(end,Direction.NORTH,roofCell,false),()->{throw new AssertionError("First hit already proves sight");}))throw new AssertionError("A visible solid can still be inspected");

 }
}
