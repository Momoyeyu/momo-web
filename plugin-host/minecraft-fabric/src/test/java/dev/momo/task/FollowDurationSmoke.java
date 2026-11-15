package dev.momo.task;
public final class FollowDurationSmoke {
 public static void main(String[] args){
  if(FollowDuration.complete(1,null)||FollowDuration.complete(1199,null)||!FollowDuration.complete(1200,null))throw new AssertionError("Normal follow watches the moving target continuously for a minute, not just first arrival");
  if(FollowDuration.complete(19,20)||!FollowDuration.complete(20,20))throw new AssertionError("Explicit duration is measured in game ticks");
  for(int invalid:new int[]{0,1801})try{FollowDuration.complete(1,invalid);throw new AssertionError("Invalid follow duration");}catch(IllegalArgumentException expected){}
  System.out.println("PASS continuous follow duration and bounded completion");
 }
}
