package dev.momo.task;
import java.util.*;
import java.util.function.ToDoubleFunction;
import net.minecraft.util.math.*;
/** Two-block local steering, not a second pathfinder or an inferred world map. */
final class EscapeRoute {
 interface Scene {
  boolean known(Box area);
  List<Box> collisions(Box area);
  boolean dangerous(Box area);
 }
 record Choice(float yaw,Vec3d landing,boolean jump){}
 private static boolean clear(Scene scene,Box box){return scene.known(box)&&scene.collisions(box).isEmpty();}
 private static boolean safe(Scene scene,Box box){return clear(scene,box)&&!scene.dangerous(box.expand(0,.08,0));}
 static Optional<Choice> choose(Box body,double ground,float facing,boolean fluid,Scene scene,ToDoubleFunction<Vec3d> score){
  var feet=body.getBottomCenter();Choice best=null;double bestScore=-Double.MAX_VALUE;
  for(int direction=0;direction<8;direction++){
   float yaw=facing+direction*45;double angle=Math.toRadians(yaw),dx=-Math.sin(angle)*2,dz=Math.cos(angle)*2;
   var column=new Box(body.minX+dx,ground-1.08,body.minZ+dz,body.maxX+dx,ground+1.08,body.maxZ+dz);
   if(!scene.known(column))continue;
   var levels=new ArrayList<Double>();
   if(fluid)levels.add(feet.y);
   scene.collisions(column).stream().map(b->b.maxY).filter(y->y>=ground-1.001&&y<=ground+1.001).distinct().sorted(Comparator.comparingDouble(y->Math.abs(y-ground))).limit(8).forEach(levels::add);
   for(double level:levels){
    double rise=level-feet.y;boolean jump=level>ground+.1;
    var landing=body.offset(dx,rise,dz);
    if(!safe(scene,landing))continue;
    if(jump&&!clear(scene,body.union(body.offset(0,Math.max(0,rise),0))))continue;
    boolean route=true;
    for(int sample=1;sample<=4;sample++){
     double fraction=sample/4.;var path=body.offset(dx*fraction,Math.max(0,rise),dz*fraction);
     if(!safe(scene,path)){route=false;break;}
     if(!jump&&!fluid){
      var support=new Box(path.minX,ground-1.08,path.minZ,path.maxX,path.minY+.001,path.maxZ);
      if(!scene.known(support)||scene.collisions(support).stream().noneMatch(b->b.maxY>=ground-1.001&&b.maxY<=ground+1.001)){route=false;break;}
     }
    }
    if(!route)continue;
    var point=new Vec3d(feet.x+dx,level,feet.z+dz);double value=score.applyAsDouble(point);
    if(Double.isFinite(value)&&value>bestScore){bestScore=value;best=new Choice(yaw,point,jump);}
    break;
   }
  }
  return Optional.ofNullable(best);
 }
}
