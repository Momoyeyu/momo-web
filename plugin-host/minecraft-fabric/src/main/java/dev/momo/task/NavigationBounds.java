package dev.momo.task;
/** Local navigation admission, moving-target renewal and stable arrival. */
public final class NavigationBounds {
 public static int arrivalTicks(boolean arrived,boolean supported,int previous){return arrived&&supported?Math.min(4,previous+1):0;}
 public static float horizonPitch(float pitch){return Math.max(-10,Math.min(20,pitch));}
 public static boolean failed(boolean arrived,boolean pathFailed){return !arrived&&pathFailed;}
 public static boolean retarget(boolean navigating,boolean settled,double movedSquared,boolean intervalElapsed){
  return !navigating||(settled&&movedSquared>0)||(intervalElapsed&&movedSquared>9);
 }
 public static boolean within(double x,double y,double z,int targetX,int targetY,int targetZ,boolean surface){
  double dx=x-targetX-.5,dz=z-targetZ-.5,dy=surface?0:y-targetY-.5;
  return dx*dx+dy*dy+dz*dz<=4096;
 }
}
