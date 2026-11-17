package dev.momo.task;
import baritone.api.pathing.goals.*;
import java.util.*;
/** Bounded collision-only surface destinations; never resource discovery. */
final class SurfaceGoals {
 enum Kind {AIR,LEAVES,SOLID,WATER,UNSAFE_FLUID}
 interface Scene {
  boolean ceiling();int bottom();
  /** Null for an unloaded column or absent client heightmap. */
  Integer top(int x,int z);
  Kind kind(int x,int y,int z);
 }
 private static void add(List<Goal> goals,int x,int top,int z,Kind kind){
  if(kind!=Kind.SOLID&&kind!=Kind.LEAVES&&kind!=Kind.WATER)return;
  goals.add(new GoalTwoBlocks(x,top,z));
  if(kind==Kind.WATER)goals.add(new GoalTwoBlocks(x,top-1,z));
 }
 static Goal create(int x,int z,Scene scene){
  if(scene.ceiling())throw new TaskRuntime.Rejected("surface_unavailable");
  var goals=new ArrayList<Goal>();int bottom=scene.bottom();
  for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++){
   int cx=x+dx,cz=z+dz;if(Math.abs((long)cx)>30000000||Math.abs((long)cz)>30000000)continue;
   Integer top=scene.top(cx,cz);if(top==null||top<=bottom)continue;
   Kind first=scene.kind(cx,top-1,cz);add(goals,cx,top,cz,first);
   if(first!=Kind.LEAVES)continue;
   // Do not initialize a missing no-leaves heightmap for a whole chunk.
   // A bounded local column can also find ordinary ground below foliage.
   for(int depth=2;depth<=32&&top-depth>=bottom;depth++){
    Kind kind=scene.kind(cx,top-depth,cz);
    if(kind==Kind.AIR||kind==Kind.LEAVES)continue;
    add(goals,cx,top-depth+1,cz,kind);break;
   }
  }
  if(goals.isEmpty())throw new TaskRuntime.Rejected("surface_unavailable");
  return new GoalComposite(goals.toArray(Goal[]::new));
 }
}
