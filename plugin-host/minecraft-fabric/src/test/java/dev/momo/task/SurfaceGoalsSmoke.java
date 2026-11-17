package dev.momo.task;
import java.util.*;
public final class SurfaceGoalsSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static class Scene implements SurfaceGoals.Scene {
  boolean ceiling;int tops,reads;final Map<String,Integer> columns=new HashMap<>();final Map<String,SurfaceGoals.Kind> blocks=new HashMap<>();
  public boolean ceiling(){return ceiling;}public int bottom(){return -64;}
  public Integer top(int x,int z){tops++;return columns.get(x+","+z);}
  public SurfaceGoals.Kind kind(int x,int y,int z){reads++;if(!columns.containsKey(x+","+z))throw new AssertionError("Unloaded column must not be read");return blocks.getOrDefault(x+","+y+","+z,SurfaceGoals.Kind.AIR);}
  Scene column(int x,int top,int z,SurfaceGoals.Kind kind){columns.put(x+","+z,top);blocks.put(x+","+(top-1)+","+z,kind);return this;}
 }
 static void unavailable(Scene scene){try{SurfaceGoals.create(3,4,scene);throw new AssertionError("A missing real surface must not fall back to a horizontal goal");}catch(TaskRuntime.Rejected error){check(error.reason.equals("surface_unavailable"),"Report a known surface limitation");}}
 public static void main(String[] args){
  var roof=new Scene().column(3,67,4,SurfaceGoals.Kind.SOLID);var goal=SurfaceGoals.create(3,4,roof);
  check(!goal.isInGoal(3,64,4),"Same X/Z inside a cave must not count as arriving at its surface");
  check(goal.isInGoal(3,67,4),"The actual upper roof remains a reachable destination");
  check(!goal.isInGoal(5,67,4)&&!goal.isInGoal(3,90,4),"Surface arrival retains bounded horizontal and vertical precision");
  var slab=SurfaceGoals.create(3,4,new Scene().column(3,65,4,SurfaceGoals.Kind.SOLID));
  check(slab.isInGoal(3,64,4),"A half slab's feet block differs from its heightmap's next full block");
  var water=SurfaceGoals.create(3,4,new Scene().column(3,64,4,SurfaceGoals.Kind.WATER));
  check(water.isInGoal(3,62,4)&&water.isInGoal(3,63,4)&&!water.isInGoal(3,58,4),"Surface swimming must not accept the bottom of a deep ocean");
  var tree=new Scene().column(3,72,4,SurfaceGoals.Kind.LEAVES);tree.blocks.put("3,64,4",SurfaceGoals.Kind.SOLID);
  var grove=SurfaceGoals.create(3,4,tree);
  check(grove.isInGoal(3,65,4)&&grove.isInGoal(3,72,4)&&!grove.isInGoal(3,60,4),"Allow real ground under foliage and a walkable canopy, never a cave below ground");
  var unloaded=new Scene();unavailable(unloaded);check(unloaded.tops<=9&&unloaded.reads==0,"Unknown columns stay unknown with a bounded local lookup");
  var nether=new Scene().column(3,128,4,SurfaceGoals.Kind.SOLID);nether.ceiling=true;unavailable(nether);
  check(nether.tops==0&&nether.reads==0,"A ceiling dimension must not search for a route above its bedrock roof");
  unavailable(new Scene().column(3,64,4,SurfaceGoals.Kind.UNSAFE_FLUID));
  var forest=new Scene(){public SurfaceGoals.Kind kind(int x,int y,int z){super.kind(x,y,z);check(y>=68,"Do not scan an entire vertical chunk below foliage");return SurfaceGoals.Kind.LEAVES;}};
  for(int x=2;x<=4;x++)for(int z=3;z<=5;z++)forest.column(x,100,z,SurfaceGoals.Kind.LEAVES);
  SurfaceGoals.create(3,4,forest);check(forest.tops<=9&&forest.reads<=288,"A task start has a finite column/state budget");
  System.out.println("PASS actual surface altitude, slabs, water, foliage, ceiling and loaded-column bounds");
 }
}
