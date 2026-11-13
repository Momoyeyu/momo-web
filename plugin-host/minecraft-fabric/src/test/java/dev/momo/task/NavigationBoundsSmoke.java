package dev.momo.task;
public final class NavigationBoundsSmoke {
 public static void main(String[] args){
  if(!NavigationBounds.within(10.5,90,10.5,20,0,10,true))throw new AssertionError("Surface navigation must ignore unused target Y");
  if(NavigationBounds.within(10.5,90,10.5,20,0,10,false))throw new AssertionError("Exact navigation still bounds height");
  if(NavigationBounds.within(0,90,0,65,90,0,true))throw new AssertionError("Surface radius must remain bounded");
  if(!NavigationBounds.within(0,90,0,3,92,4,false))throw new AssertionError("Nearby exact point rejected");
 }
}
