package dev.momo.task;
/** Short visible water approaches for pursuit, interaction and pickup; long routes still belong to Baritone. */
public final class WaterApproach {
 public static boolean surfaceRoute(boolean playerWater,boolean targetWater){return playerWater&&targetWater;}
 public record Swim(boolean steer,boolean forward,boolean up,boolean down){}
 public static Swim swim(boolean playerWater,boolean dropWater,boolean visible,double dx,double dy,double dz){
  double distance=dx*dx+dy*dy+dz*dz;
  if(!playerWater||!dropWater||!visible||!Double.isFinite(distance)||distance>64)return new Swim(false,false,false,false);
  return new Swim(true,dx*dx+dz*dz>.16,dy>.25,dy<-.25);
 }
}
