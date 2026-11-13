package dev.momo.task;

import java.util.LinkedHashSet;
import java.util.Set;

/** Local monotonic lifecycle; model/network round trips never advance physical movement. */
public final class NavigationTask {
 public interface Driver {
  void start(int x,int y,int z);
  void stop();
  boolean arrived();
  boolean failed();
 }
 private final Driver driver;
 private final Set<String> accepted=new LinkedHashSet<>();
 private String state="idle", reason="", id="";
 private long expires;
 private int goalX,goalY,goalZ;
 public NavigationTask(Driver driver){this.driver=driver;}
 public boolean start(String taskId,int x,int y,int z,long now,long leaseMs){
  if(taskId==null||!taskId.matches("[A-Za-z0-9_-]{1,80}")||leaseMs<1||leaseMs>30000)throw new IllegalArgumentException("Invalid navigation task");
  if(accepted.contains(taskId))return false;
  if(active())throw new IllegalStateException("Navigation already owns the body");
  if(accepted.size()>=256)throw new IllegalStateException("Navigation task history full; reconnect required");
  goalX=x;goalY=y;goalZ=z;
  accepted.add(taskId);id=taskId;state="running";reason="";expires=now+leaseMs;
  try{driver.start(x,y,z);}catch(RuntimeException error){finish("failed","start_failed");throw error;}
  return true;
 }
 public void tick(long now){
  if(!active())return;
  if(now>=expires)finish("failed","lease_expired");
  else if(state.equals("paused"))return;
  else if(driver.arrived())finish("succeeded","arrived");
  else if(driver.failed())finish("failed","unreachable");
 }
 public void renew(long now,long leaseMs){
  if(leaseMs<1||leaseMs>30000)throw new IllegalArgumentException("Invalid lease");
  if(active()&&now<expires)expires=now+leaseMs;
  else if(active())finish("failed","lease_expired");
 }
 public void pause(){if(state.equals("running")){state="paused";reason="menu_opened";driver.stop();}}
 public void resume(long now){
  if(!state.equals("paused"))return;
  if(now>=expires){finish("failed","lease_expired");return;}
  state="running";reason="";
  try{driver.start(goalX,goalY,goalZ);}catch(RuntimeException error){finish("failed","resume_failed");}
 }
 public void cancel(String why){if(active())finish("cancelled",why);}
 private void finish(String status,String why){state=status;reason=why;driver.stop();}
 public boolean active(){return state.equals("running")||state.equals("paused");}
 public String state(){return state;}
 public String reason(){return reason;}
 public String id(){return id;}
}
