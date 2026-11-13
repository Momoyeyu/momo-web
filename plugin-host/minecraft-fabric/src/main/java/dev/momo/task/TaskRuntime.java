package dev.momo.task;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Game-thread owned bounded task queue. Never waits for a network or model response. */
public final class TaskRuntime {
 public static final class Rejected extends IllegalStateException {
  public final String reason;
  public Rejected(String reason){super(reason);if(!reason.matches("[a-z_]{1,64}"))throw new IllegalArgumentException("Invalid failure code");this.reason=reason;}
 }
 public static String reason(RuntimeException error,String fallback){return error instanceof Rejected rejected?rejected.reason:fallback;}
 public interface Work {
  void start();
  Step tick();
  void pause();
  void resume();
  void stop();
  default boolean acceptsScreen(Object screen){return false;}
  default Map<String,Object> progress(){return Map.of();}
  default Map<String,Object> partialEvidence(){return Map.of();}
  default boolean controlsMining(){return false;}
  default boolean handlesCombat(){return false;}
  default boolean retrySafe(String reason){return false;}
 }
 public record Step(String state,String reason,Map<String,Object> evidence){
  public static Step running(){return new Step("running","",Map.of());}
  public static Step done(Map<String,Object> evidence){return new Step("succeeded","",Map.copyOf(evidence));}
  public static Step failed(String reason){return new Step("failed",reason,Map.of());}
 }
 public record Snapshot(String taskId,String skill,String state,String reason,Map<String,Object> evidence,Map<String,Object> progress){}
 public record Event(long seq,Snapshot task){}
 public record Events(long cursor,boolean gap,List<Event> events){}
 private static final int MAX_PENDING=5,MAX_HISTORY=4096,MAX_EVENTS=256;
 private static final long MAX_LIFETIME=600000;
 private static final class Job {
  final String id,skill,key;Work work;final long deadline;
  long lease;String state="queued",reason="";Map<String,Object> evidence=Map.of(),progress=Map.of();long lastProgress;
  Job(String id,String skill,String key,Work work,long now,long duration){this.id=id;this.skill=skill;this.key=key;this.work=work;lease=now+duration;deadline=now+MAX_LIFETIME;}
  boolean terminal(){return state.equals("succeeded")||state.equals("failed")||state.equals("cancelled");}
  Snapshot snapshot(){return new Snapshot(id,skill,state,reason,evidence,progress);}
 }
 private final Map<String,Job> history=new LinkedHashMap<>();
 private final ArrayDeque<Job> queue=new ArrayDeque<>();
 private final ArrayDeque<Event> journal=new ArrayDeque<>();
 private Job current;
 private Work uncertainStop;
 private long sequence;
 private boolean paused;
 public boolean submit(String id,String skill,Work work,long now,long leaseMs){return submit(id,skill,skill,work,now,leaseMs);}
 public boolean submit(String id,String skill,String key,Work work,long now,long leaseMs){
  if(id==null||!id.matches("[A-Za-z0-9_-]{1,80}")||skill==null||key==null||key.length()>3500||work==null)throw new IllegalArgumentException("Invalid task");
  validateLease(leaseMs);
  if(uncertainStop!=null)throw new IllegalStateException("Previous stop unconfirmed");
  if(history.containsKey(id)){
   if(!history.get(id).skill.equals(skill)||!history.get(id).key.equals(key))throw new IllegalArgumentException("Task identity conflict");
   return false;
  }
  if(queue.size()+(current==null?0:1)>=MAX_PENDING)throw new IllegalStateException("Task queue full");
  if(history.size()>=MAX_HISTORY)throw new IllegalStateException("Task history exhausted; new activity required");
  Job job=new Job(id,skill,key,work,now,leaseMs);history.put(id,job);queue.add(job);publish(job);return true;
 }
 public void tick(long now){
  if(uncertainStop!=null){
   try{uncertainStop.stop();uncertainStop=null;}catch(RuntimeException error){return;}
  }
  for(Job job:new ArrayList<>(queue))if(now>=job.lease||now>=job.deadline){queue.remove(job);finish(job,"failed","lease_expired",Map.of());}
  if(current!=null&&(now>=current.lease||now>=current.deadline))finish(current,"failed","lease_expired",Map.of());
  if(uncertainStop!=null)return;
  if(paused)return;
  if(current==null&&!queue.isEmpty()){
   current=queue.remove();current.state="running";publish(current);
   try{current.work.start();}catch(RuntimeException error){finish(current,"failed",reason(error,"start_failed"),Map.of());}
  }
  if(current==null)return;
  try{
   Step step=current.work.tick();
   if(step==null)throw new IllegalStateException("Missing task outcome");
   if(step.state.equals("succeeded")){
    if(step.evidence.isEmpty())finish(current,"failed","unverified_result",Map.of());
    else finish(current,"succeeded","",Map.copyOf(step.evidence));
   }else if(step.state.equals("failed"))finish(current,"failed",step.reason,step.evidence);
   else if(step.state.equals("running")&&now-current.lastProgress>=1000){
    var progress=Map.copyOf(current.work.progress());
    if(!progress.equals(current.progress)){current.progress=progress;publish(current);}current.lastProgress=now;
   }
   else if(!step.state.equals("running"))throw new IllegalArgumentException("Invalid outcome");
  }catch(RuntimeException error){System.getLogger("momo-minecraft").log(System.Logger.Level.WARNING,"Local skill failed",error);if(current!=null)finish(current,"failed",reason(error,"execution_failed"),Map.of());}
 }
 public void heartbeat(long now,long leaseMs){
  validateLease(leaseMs);
  for(Job job:new ArrayList<>(history.values()))if(!job.terminal()){
   if(now>=job.lease||now>=job.deadline){queue.remove(job);finish(job,"failed","lease_expired",Map.of());}
   else job.lease=Math.min(job.deadline,now+leaseMs);
  }
 }
 public void pause(){
  paused=true;
  if(current!=null&&!current.state.equals("paused")){
   try{current.work.pause();current.state="paused";current.reason="paused";publish(current);}
   catch(RuntimeException error){finish(current,"failed","pause_failed",Map.of());}
  }
 }
 public void resume(){
  paused=false;
  if(current!=null&&current.state.equals("paused")){
   try{current.work.resume();current.state="running";current.reason="";publish(current);}
   catch(RuntimeException error){finish(current,"failed","resume_failed",Map.of());}
  }
 }
 public void cancel(String id,String reason){
  Job job=history.get(id);
  if(job==null)throw new IllegalArgumentException("Unknown task");
  if(!job.terminal()){queue.remove(job);finish(job,"cancelled",reason,Map.of());}
 }
 public void stop(String reason){
  if(uncertainStop!=null){try{uncertainStop.stop();uncertainStop=null;}catch(RuntimeException ignored){}}
  if(current!=null)finish(current,"cancelled",reason,Map.of());
  while(!queue.isEmpty())finish(queue.remove(),"cancelled",reason,Map.of());
  paused=false;
 }
 public void resetSession(){
  if(!stopConfirmed())throw new IllegalStateException("Control must stop before changing scope");
  history.clear();journal.clear();sequence=0;paused=false;
 }
 public List<Snapshot> recentSnapshots(){
  var values=snapshots();return values.subList(Math.max(0,values.size()-64),values.size());
 }
 public Snapshot snapshot(String id){
  Job job=history.get(id);if(job==null)throw new IllegalArgumentException("Unknown task");return job.snapshot();
 }
 public List<Snapshot> snapshots(){return history.values().stream().map(Job::snapshot).toList();}
 public Events events(long after){
  if(after<0)throw new IllegalArgumentException("Invalid event cursor");
  boolean gap=after>sequence||(!journal.isEmpty()&&after<journal.getFirst().seq-1);
  return new Events(sequence,gap,journal.stream().filter(e->e.seq>after).toList());
 }
 public void notice(String reason){
  if(reason==null||!reason.matches("[a-z_]{1,50}"))throw new IllegalArgumentException("Invalid control notice");
  journal.add(new Event(++sequence,new Snapshot("control-"+sequence,"control","cancelled",reason,Map.of(),Map.of())));
  while(journal.size()>MAX_EVENTS)journal.removeFirst();
 }
 public boolean acceptsScreen(Object screen){return current!=null?current.work.acceptsScreen(screen):!queue.isEmpty()&&queue.peek().work.acceptsScreen(screen);}
 public boolean active(){return uncertainStop!=null||current!=null||!queue.isEmpty();}
 public boolean releasePending(){return uncertainStop!=null;}
 public boolean controlsMining(){return current!=null&&current.state.equals("running")&&current.work.controlsMining();}
 public boolean handlesCombat(){return current!=null&&current.work!=null&&current.work.handlesCombat();}
 public boolean stopConfirmed(){return uncertainStop==null&&current==null&&queue.isEmpty();}
 private void finish(Job job,String state,String reason,Map<String,Object> evidence){
  if(job==null||job.terminal())return;
  boolean owns=job==current;
  job.state=state;job.reason=reason;job.evidence=evidence;
  if(owns){
   try{var partial=new LinkedHashMap<>(job.work.partialEvidence());partial.putAll(evidence);job.evidence=Map.copyOf(partial);}
   catch(RuntimeException ignored){/* Receipt collection must never prevent releasing the body. */}
   try{job.work.stop();}catch(RuntimeException error){job.state="failed";job.reason="stop_unconfirmed";uncertainStop=job.work;}
   current=null;
  }
  // Keep immutable facts/idempotency keys, never a screen/player/world graph.
  job.work=null;
  publish(job);
 }
 private void publish(Job job){
  journal.add(new Event(++sequence,job.snapshot()));
  while(journal.size()>MAX_EVENTS)journal.removeFirst();
 }
 private static void validateLease(long lease){if(lease<1||lease>30000)throw new IllegalArgumentException("Invalid task lease");}
}
