package dev.momo.task;
import java.util.*;
/** Candidate feet positions for reaching a known block, not standing inside it. */
final class InteractionReach {
 record Foot(int x,int y,int z){}
 static boolean within(double x,double y,double z,int tx,int ty,int tz,double eye,double reach){double dx=x-tx,dy=y+eye-ty-.5,dz=z-tz;return dx*dx+dy*dy+dz*dz<=reach*reach;}
 static List<Foot> candidates(int tx,int ty,int tz,double px,double py,double pz,double eye,double reach){
  var result=new ArrayList<Foot>();
  for(int dx=-4;dx<=4;dx++)for(int dy=-5;dy<=3;dy++)for(int dz=-4;dz<=4;dz++)if(within(tx+dx,ty+dy,tz+dz,tx,ty,tz,eye,reach+1))result.add(new Foot(tx+dx,ty+dy,tz+dz));
  result.sort(Comparator.comparingDouble(p->(p.x()+.5-px)*(p.x()+.5-px)+(p.y()-py)*(p.y()-py)+(p.z()+.5-pz)*(p.z()+.5-pz)));
  return List.copyOf(result);
 }
}
