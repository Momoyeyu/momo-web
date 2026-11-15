package dev.momo.task;
import java.util.*;
/** Candidate feet positions for reaching a known block, not standing inside it. */
final class InteractionReach {
 record Foot(int x,int y,int z){}
 static boolean within(double x,double y,double z,int tx,int ty,int tz,double eye,double reach){double dx=x-tx,dy=y+eye-ty-.5,dz=z-tz;return dx*dx+dy*dy+dz*dz<=reach*reach;}
 // Vanilla ServerPlayerEntity checks each bed half from feet, not eye ray reach.
 static boolean bedWithin(double x,double y,double z,int tx,int ty,int tz){return Math.abs(x-tx-.5)<=3&&Math.abs(y-ty)<=2&&Math.abs(z-tz-.5)<=3;}
 // Baritone settles on entry to a feet cell; retain margin for its half-cell offset.
 static boolean bedApproach(double x,double y,double z,int tx,int ty,int tz){return Math.abs(x-tx-.5)<=2.25&&Math.abs(y-ty)<=1.5&&Math.abs(z-tz-.5)<=2.25;}
 static List<Foot> candidates(int tx,int ty,int tz,double px,double py,double pz,double eye,double reach){
  var result=new ArrayList<Foot>();
  for(int dx=-4;dx<=4;dx++)for(int dy=-5;dy<=3;dy++)for(int dz=-4;dz<=4;dz++)if(within(tx+dx,ty+dy,tz+dz,tx,ty,tz,eye,reach+1))result.add(new Foot(tx+dx,ty+dy,tz+dz));
  result.sort(Comparator.comparingDouble(p->(p.x()+.5-px)*(p.x()+.5-px)+(p.y()-py)*(p.y()-py)+(p.z()+.5-pz)*(p.z()+.5-pz)));
  return List.copyOf(result);
 }
}
