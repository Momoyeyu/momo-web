package dev.momo.task;
/** Player handoff invalidates commands inferred before it; authority resets separately. */
public final class PauseBarrier {
 private boolean paused;private long pausedAt;
 public void pause(long now){paused=true;pausedAt=now;}
 public boolean isPaused(){return paused;}
 public boolean resume(long inputAt){if(paused&&inputAt<=pausedAt)return false;paused=false;return true;}
 public void reset(){paused=false;pausedAt=0;}
}
