package dev.momo.task;
import java.util.List;
import net.minecraft.util.math.*;
import net.minecraft.util.hit.BlockHitResult;
public final class VisibilityBoundarySmoke {
 static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
 public static void main(String[] args){
  var memory=new SeenTarget<String>("last visible",3);
  check(memory.sample(false,()->{throw new AssertionError("hidden live coordinates read");}).equals("last visible"),"occluded approach uses last seen only");
  check(!memory.lost(),"a short occlusion can recover");
  check(memory.sample(true,()->"seen again").equals("seen again"),"visible sample updates target");
  memory.sample(false,()->"forbidden");memory.sample(false,()->"forbidden");memory.sample(false,()->"forbidden");memory.sample(false,()->"forbidden");
  check(memory.lost(),"lost target search must be bounded");
  var target=new BlockPos(0,0,0);var eye=new Vec3d(0.5,2,0.5);var shape=List.of(new Box(0,0,0,1,1,1));
  var wrongFace=BlockSight.hit(eye,target,shape,Direction.DOWN,end->new BlockHitResult(new Vec3d(.5,1,.5),Direction.UP,target,false));
  check(wrongFace==null,"visible support top must not fabricate a click on its hidden underside");
  var occluded=BlockSight.hit(eye,target,shape,Direction.UP,end->new BlockHitResult(new Vec3d(.5,1.5,.5),Direction.UP,target.up(),false));
  check(occluded==null,"an occluding block cannot certify the requested face");
  var visible=BlockSight.hit(eye,target,shape,Direction.UP,end->new BlockHitResult(new Vec3d(.5,1,.5),Direction.UP,target,false));
  check(visible!=null&&visible.getSide()==Direction.UP,"a real matching face retains its ray hit");
  System.out.println("PASS last-seen bounded pursuit and actual placement face ray boundary");
 }
}
