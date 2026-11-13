package dev.momo.task;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import baritone.api.pathing.goals.GoalNear;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;

/** API-only ownership. Discovery/mining scans and arbitrary Baritone commands are not exposed. */
public final class BaritoneNavigator implements NavigationTask.Driver {
 private IBaritone baritone;
 private GoalNear goal;
 private int warmup;
 public void start(int x,int y,int z){
  baritone=BaritoneAPI.getProvider().getPrimaryBaritone();
  if(baritone.getPathingBehavior().isPathing())throw new IllegalStateException("Another navigator owns control");
  goal=new GoalNear(new BlockPos(x,y,z),1);
  warmup=4;
  baritone.getCustomGoalProcess().setGoalAndPath(goal);
 }
 public void stop(){
  if(baritone!=null&&goal!=null)baritone.getPathingBehavior().cancelEverything();
  goal=null;
 }
 public boolean arrived(){
  var client=MinecraftClient.getInstance();
  return goal!=null&&client.player!=null&&goal.isInGoal(client.player.getBlockPos());
 }
 public boolean failed(){
  if(warmup-->0)return false;
  return baritone!=null&&!baritone.getCustomGoalProcess().isActive()&&!baritone.getPathingBehavior().isPathing();
 }
 public static boolean available(){return BaritoneAPI.getProvider().getPrimaryBaritone()!=null;}
}
