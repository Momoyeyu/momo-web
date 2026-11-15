package dev.momo.task;
final class FollowDuration {
 static boolean complete(int elapsed,Integer requested){int ticks=requested==null?1200:requested;if(ticks<1||ticks>1800)throw new IllegalArgumentException("Invalid follow duration");return elapsed>=ticks;}
}
