package dev.momo.task;
/** Surface goals ignore target altitude, but retain the same local horizontal radius. */
public final class NavigationBounds {
 public static boolean within(double x,double y,double z,int targetX,int targetY,int targetZ,boolean surface){
  double dx=x-targetX-.5,dz=z-targetZ-.5,dy=surface?0:y-targetY-.5;
  return dx*dx+dy*dy+dz*dz<=4096;
 }
}
