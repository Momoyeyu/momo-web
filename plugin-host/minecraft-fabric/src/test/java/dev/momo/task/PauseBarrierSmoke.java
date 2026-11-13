package dev.momo.task;
public final class PauseBarrierSmoke {
 public static void main(String[] args){
  PauseBarrier barrier=new PauseBarrier();barrier.pause(100);
  if(barrier.resume(99)||barrier.resume(100)||!barrier.isPaused())throw new AssertionError("in-flight input cannot undo a newer handoff");
  if(!barrier.resume(101)||barrier.isPaused())throw new AssertionError("fresh player input may restore control");
  barrier.pause(200);if(barrier.resume(101))throw new AssertionError("a second handoff invalidates old resume requests");
  barrier.reset();if(!barrier.resume(0))throw new AssertionError("new authorized activity starts with a fresh barrier");
  System.out.println("PASS player pause wins over late model commands");
 }
}
