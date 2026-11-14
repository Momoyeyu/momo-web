package dev.momo.task;
import java.util.*;
/** First-hit sight samples only: no block enumeration, hidden resources or unloaded data. */
public final class SightLandmarks {
 public record Hit(int x,int y,int z,String block,int priority){}
 public interface Ray {Hit cast(double dx,double dy,double dz);}
 public static List<Hit> collect(double x,double y,double z,Ray ray){
  return collect(x,y,z,0,ray);
 }
 public static List<Hit> collect(double x,double y,double z,double facing,Ray ray){
  return collect(x,y,z,facing,0,ray);
 }
 public static List<Hit> collect(double x,double y,double z,double facing,double pitch,Ray ray){
  var found=new LinkedHashMap<String,Hit>();
  var angles=new ArrayList<double[]>();
  for(int yaw=-30;yaw<=30;yaw+=6)for(int offset:new int[]{-16,-10,-6,-3,0,4,8})angles.add(new double[]{facing+yaw,Math.max(-89,Math.min(89,pitch+offset))});
  for(int yaw=0;yaw<360;yaw+=36)for(int offset:new int[]{-8,-3,0,8})angles.add(new double[]{yaw,offset});
  for(var angle:angles){
   double p=Math.toRadians(angle[1]),a=Math.toRadians(angle[0]);
   Hit hit=ray.cast(-Math.sin(a)*Math.cos(p)*96,-Math.sin(p)*96,Math.cos(a)*Math.cos(p)*96);
   if(hit==null||hit.priority<0||hit.priority>=3)continue;
   double dx=hit.x+.5-x,dy=hit.y+.5-y,dz=hit.z+.5-z;
   if(dx*dx+dy*dy+dz*dz>96*96)continue;
   found.putIfAbsent(hit.x+","+hit.y+","+hit.z,hit);
  }
  return found.values().stream().sorted(Comparator.comparingInt(Hit::priority).thenComparingDouble(h->Math.pow(h.x+.5-x,2)+Math.pow(h.y+.5-y,2)+Math.pow(h.z+.5-z,2))).limit(6).toList();
 }
}
