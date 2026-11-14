package dev.momo.task;
import java.util.*;
/** First-hit sight samples only: no block enumeration, hidden resources or unloaded data. */
public final class SightLandmarks {
 public record Hit(int x,int y,int z,String block,int priority){}
 public interface Ray {Hit cast(double dx,double dy,double dz);}
 public static List<Hit> collect(double x,double y,double z,Ray ray){
  var found=new LinkedHashMap<String,Hit>();
  for(int pitch:new int[]{-20,-8,0,8,20})for(int yaw=0;yaw<360;yaw+=15){
   double p=Math.toRadians(pitch),a=Math.toRadians(yaw);
   Hit hit=ray.cast(-Math.sin(a)*Math.cos(p)*48,-Math.sin(p)*48,Math.cos(a)*Math.cos(p)*48);
   if(hit==null||hit.priority<0||hit.priority>=3)continue;
   double dx=hit.x+.5-x,dy=hit.y+.5-y,dz=hit.z+.5-z;
   if(dx*dx+dy*dy+dz*dz>48*48)continue;
   found.putIfAbsent(hit.x+","+hit.y+","+hit.z,hit);
  }
  return found.values().stream().sorted(Comparator.comparingInt(Hit::priority).thenComparingDouble(h->Math.pow(h.x+.5-x,2)+Math.pow(h.y+.5-y,2)+Math.pow(h.z+.5-z,2))).limit(6).toList();
 }
}
