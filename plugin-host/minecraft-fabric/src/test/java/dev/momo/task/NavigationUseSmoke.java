package dev.momo.task;
public final class NavigationUseSmoke {
 public static void main(String[] args){
  var guard=new NavigationUseGuard();var navigation=new Object();var newer=new Object();
  if(guard.block(true,false,false))throw new AssertionError("No momo navigation must leave ordinary input alone");
  guard.begin(navigation,true);
  if(!guard.block(true,false,false))throw new AssertionError("Preserve navigation's misaligned right click must not open a loom");
  if(guard.block(true,false,true))throw new AssertionError("Aligned doors and gates must remain usable while walking");
  if(guard.block(false,false,false))throw new AssertionError("A real workstation or shield skill is not Baritone's automatic right click");
  if(guard.block(true,true,false))throw new AssertionError("Physical takeover must win before the next task tick");
  guard.begin(newer,true);guard.end(navigation);
  if(!guard.block(true,false,false))throw new AssertionError("Late cleanup of an old navigator cannot clear a newer scope");
  guard.end(newer);
  if(guard.block(true,false,false))throw new AssertionError("Stop must leave no stale input restriction");
  guard.begin(navigation,false);
  if(guard.block(true,false,false))throw new AssertionError("Adaptive navigation still needs its normal block-placement path");
 }
}
