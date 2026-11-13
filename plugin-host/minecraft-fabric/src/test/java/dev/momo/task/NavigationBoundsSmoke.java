package dev.momo.task;
public final class NavigationBoundsSmoke {
 public static void main(String[] args){
  if(!NavigationBounds.within(10.5,90,10.5,20,0,10,true))throw new AssertionError("Surface navigation must ignore unused target Y");
  if(NavigationBounds.within(10.5,90,10.5,20,0,10,false))throw new AssertionError("Exact navigation still bounds height");
  if(NavigationBounds.within(0,90,0,65,90,0,true))throw new AssertionError("Surface radius must remain bounded");
  if(!NavigationBounds.within(0,90,0,3,92,4,false))throw new AssertionError("Nearby exact point rejected");
  if(!NavigationBounds.retarget(true,true,1,false))throw new AssertionError("Arrival at an old moving target is not unreachable");
  if(NavigationBounds.retarget(true,false,1,false))throw new AssertionError("Small movement must not restart an active path every tick");
  if(!NavigationBounds.retarget(true,false,16,true))throw new AssertionError("Moving target needs bounded periodic replanning");
  if(NavigationBounds.retarget(true,true,0,true))throw new AssertionError("An unchanged exhausted path must not retry forever");
  if(NavigationBounds.arrivalTicks(true,false,3)!=0)throw new AssertionError("Passing a goal while falling is not a stable arrival");
  if(NavigationBounds.arrivalTicks(false,true,3)!=0)throw new AssertionError("Leaving a goal resets settlement");
  if(NavigationBounds.arrivalTicks(true,true,3)!=4)throw new AssertionError("Stable arrival must settle over consecutive ticks");
  if(NavigationBounds.horizonPitch(90)>20||NavigationBounds.horizonPitch(-90)<-10)throw new AssertionError("Navigation must leave an inspectable horizon, not a floor-only frame");
  if(NavigationBounds.failed(true,true))throw new AssertionError("An airborne surface goal may settle after the path process ends");
  if(!NavigationBounds.failed(false,true))throw new AssertionError("An exhausted path outside the goal remains a failure");
 }
}
