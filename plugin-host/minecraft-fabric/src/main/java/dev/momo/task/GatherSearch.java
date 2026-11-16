package dev.momo.task;
/** Finite changes of viewpoint after an empty sight pass, not a resource scan. */
final class GatherSearch {
 record Point(int x,int z){}
 private int attempts;
 Point next(int x,int z,float facing){
  if(attempts==4)return null;
  double angle=Math.toRadians(facing+90*attempts++);
  return new Point(x-(int)Math.round(Math.sin(angle)*12),z+(int)Math.round(Math.cos(angle)*12));
 }
 int attempts(){return attempts;}
}
