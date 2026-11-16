package dev.momo.task;
/** Geometry regression: a visible remaining trunk above the player was missed. */
public final class GatherSightSmoke {
 private static boolean hits(double[] min,double[] max){
  for(int i=0;i<512;i++){
   double[] ray=GatherSight.direction(i);double near=0,far=16;
   for(int axis=0;axis<3;axis++){
    if(Math.abs(ray[axis])<1e-12){if(min[axis]>0||max[axis]<0){far=-1;break;}continue;}
    double a=min[axis]/ray[axis],b=max[axis]/ray[axis];near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
   }
   if(near<=far)return true;
  }
  return false;
 }
 public static void main(String[] args){
  if(!hits(new double[]{-.5,2.38,-.5},new double[]{.5,3.38,.5}))throw new AssertionError("Remaining visible trunk directly overhead must be sampled");
  if(!hits(new double[]{-.5,-3.5,-.5},new double[]{.5,-2.5,.5}))throw new AssertionError("Downward sight must not leave a blind cone; support protection is separate");
  if(!hits(new double[]{3,-.5,-.5},new double[]{4,.5,.5}))throw new AssertionError("Nearby horizontal resources remain visible");
  for(int i=0;i<512;i++){
   double[] ray=GatherSight.direction(i);double norm=ray[0]*ray[0]+ray[1]*ray[1]+ray[2]*ray[2];
   if(!Double.isFinite(norm)||Math.abs(norm-1)>1e-9)throw new AssertionError("Finite normalized sight ray required");
  }
 }
}
