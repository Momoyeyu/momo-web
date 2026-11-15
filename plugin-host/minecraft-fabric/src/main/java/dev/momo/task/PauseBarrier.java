package dev.momo.task;
/** Player handoff invalidates commands inferred before it; authority resets separately. */
public final class PauseBarrier {
 private boolean paused,suspended;private long pausedAt,revision;
 public void pause(long now){paused=true;pausedAt=now;revision++;}
 public boolean isPaused(){return paused;}
 public long revision(){return revision;}
 public void observeSuspension(boolean value){if(value!=suspended){suspended=value;revision++;}}
 public boolean resume(long inputAt){if(paused&&inputAt<=pausedAt)return false;paused=false;revision++;return true;}
 public void reset(){paused=suspended=false;pausedAt=0;revision++;}
}
