package dev.momo.task;
import java.util.HashSet;
/** A failed stationary scan gets finite nearby movement, not an endless patrol. */
public final class GatherSearchSmoke {
 public static void main(String[] args){
  for(float yaw:new float[]{0,45,123,-179}){
   var search=new GatherSearch();var seen=new HashSet<GatherSearch.Point>();int count=0;
   for(var point=search.next(100,-200,yaw);point!=null;point=search.next(100,-200,yaw)){
    double distance=Math.hypot(point.x()-100,point.z()+200);
    if(distance<8||distance>16)throw new AssertionError("Search must change viewpoint without leaving the local area");
    if(!seen.add(point))throw new AssertionError("An exhausted vantage cannot repeat");
    if(++count>4)throw new AssertionError("Search must finish without a model or external stop");
   }
   if(count==0||search.next(100,-200,yaw)!=null)throw new AssertionError("No walk before scanning; exhausted work stays exhausted");
  }
 }
}
