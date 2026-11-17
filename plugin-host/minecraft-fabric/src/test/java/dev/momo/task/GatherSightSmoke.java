package dev.momo.task;
/** Geometry regression: a visible remaining trunk above the player was missed. */
public final class GatherSightSmoke {
 private static boolean hits(double[] min,double[] max){
  return hits(min,max,512);
 }
 private static boolean hits(double[] min,double[] max,int rays){
  for(int i=0;i<rays;i++){
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
  boolean reachableFloor=false;
  for(int x=-2;x<=2;x++)for(int z=-2;z<=2;z++)if(x!=0||z!=0)
   reachableFloor|=hits(new double[]{x-.5,-2.62,z-.5},new double[]{x+.5,-1.62,z+.5},16);
  if(!reachableFloor)throw new AssertionError("The first bounded sight batch must inspect reachable adjacent floor, instead of searching only overhead until it chases a distant hillside");
  if(!hits(new double[]{-.5,2.38,-.5},new double[]{.5,3.38,.5}))throw new AssertionError("Remaining visible trunk directly overhead must be sampled");
  if(!hits(new double[]{-.5,-3.5,-.5},new double[]{.5,-2.5,.5}))throw new AssertionError("Downward sight must not leave a blind cone; support protection is separate");
  if(!hits(new double[]{3,-.5,-.5},new double[]{4,.5,.5}))throw new AssertionError("Nearby horizontal resources remain visible");
  for(int i=0;i<512;i++){
   double[] ray=GatherSight.direction(i);double norm=ray[0]*ray[0]+ray[1]*ray[1]+ray[2]*ray[2];
   if(!Double.isFinite(norm)||Math.abs(norm-1)>1e-9)throw new AssertionError("Finite normalized sight ray required");
  }
 }
}
