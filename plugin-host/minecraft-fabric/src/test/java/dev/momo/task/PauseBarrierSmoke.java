package dev.momo.task;
public final class PauseBarrierSmoke {
 public static void main(String[] args){
  PauseBarrier barrier=new PauseBarrier();barrier.pause(100);
  if(barrier.resume(99)||barrier.resume(100)||!barrier.isPaused())throw new AssertionError("in-flight input cannot undo a newer handoff");
  if(!barrier.resume(101)||barrier.isPaused())throw new AssertionError("fresh player input may restore control");
  barrier.pause(200);if(barrier.resume(101))throw new AssertionError("a second handoff invalidates old resume requests");
  barrier.reset();if(!barrier.resume(0))throw new AssertionError("new authorized activity starts with a fresh barrier");
  long current=barrier.revision();barrier.observeSuspension(false);
  if(barrier.revision()!=current)throw new AssertionError("identical tick samples must not cancel healthy decisions");
  barrier.observeSuspension(true);barrier.observeSuspension(false);
  if(barrier.revision()!=current+2||barrier.isPaused())throw new AssertionError("menu/focus roundtrip is remembered even when both Python polls see an active game");
  current=barrier.revision();barrier.pause(300);
  if(barrier.revision()<=current)throw new AssertionError("manual handoff invalidates a claimed decision");
  current=barrier.revision();if(barrier.resume(299)||barrier.revision()!=current)throw new AssertionError("denied resume cannot change the handoff fence");
  if(!barrier.resume(301)||barrier.revision()<=current)throw new AssertionError("fresh resume permits new decisions, never the old claim");
  current=barrier.revision();barrier.reset();if(barrier.revision()<=current)throw new AssertionError("session reset cannot recycle a control revision");
  System.out.println("PASS player pause wins over late model commands");
 }
}
