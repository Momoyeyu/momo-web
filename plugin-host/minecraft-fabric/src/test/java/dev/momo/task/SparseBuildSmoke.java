package dev.momo.task;
import java.util.List;
public final class SparseBuildSmoke {
 public static void main(String[] args){
  var a=new SparseBuild.Cell(-4,64,2,"minecraft:oak_planks");var b=new SparseBuild.Cell(-2,65,3,"minecraft:oak_slab");var plan=new SparseBuild(List.of(a,b));
  if(plan.width()!=3||plan.height()!=2||plan.length()!=2||!a.equals(plan.local(0,0,0))||plan.local(1,0,0)!=null||!b.equals(plan.local(2,1,1)))throw new AssertionError("sparse world cells need an exact offset, never filling the empty bounding box");
  reject(List.of());reject(List.of(a,a));reject(List.of(a,new SparseBuild.Cell(20,64,2,"minecraft:oak_planks")));
  reject(java.util.Collections.nCopies(33,a));
  var settling=new BuildSettlement(20);
  for(int i=0;i<80;i++)if(settling.missingReceiptExpired(true))throw new AssertionError("Active building has no completion deadline");
  for(int i=0;i<19;i++)if(settling.missingReceiptExpired(false))throw new AssertionError("Library completion must allow server receipts to arrive");
  if(!settling.missingReceiptExpired(false))throw new AssertionError("Missing receipts eventually fail");
  if(settling.missingReceiptExpired(true)||settling.missingReceiptExpired(false))throw new AssertionError("New library activity resets settlement, regardless of total build age");
  var stalled=new BuildProgress(3,6);
  if(stalled.blocked(0,0,64,0)||stalled.blocked(0,0,64,0)||stalled.blocked(0,0,64,0)||!stalled.blocked(0,0,64,0))throw new AssertionError("A stationary blocked builder must yield instead of waiting for its whole task lifetime");
  var circling=new BuildProgress(3,6);
  for(int i=0;i<6;i++)if(circling.blocked(0,i,64,0))throw new AssertionError("Movement permits bounded approach");
  if(!circling.blocked(0,6,64,0))throw new AssertionError("Movement alone cannot count as construction forever");
  if(circling.blocked(1,6,64,0)||circling.blocked(1,6,64,0))throw new AssertionError("Verified construction renews the work budget");
  System.out.println("PASS bounded sparse blueprint, exact offsets and no duplicate/implicit fill");
 }
 private static void reject(List<SparseBuild.Cell> cells){try{new SparseBuild(cells);throw new AssertionError("Accepted invalid build");}catch(IllegalArgumentException expected){}}
}
