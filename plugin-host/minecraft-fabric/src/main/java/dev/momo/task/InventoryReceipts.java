package dev.momo.task;
import java.util.*;
/** Only complete server snapshots enter this bounded game-thread ledger. */
public final class InventoryReceipts {
 public static final InventoryReceipts CURRENT=new InventoryReceipts();
 public record Receipt(long sequence,int revision,List<String> slots,String cursor){}
 public record WindowReceipt(long sequence,String target,int handler){}
 public record WindowRequest(Object world,String target,long boundary,long deadline){}
 private Object openedWindow;private WindowReceipt opened;
 private Object world;private long sequence;private final LinkedHashMap<Integer,Receipt> recent=new LinkedHashMap<>();
 private record Address(int handler,int slot){}
 private record Delta(long sequence,String value){}
 private final LinkedHashMap<Address,Delta> deltas=new LinkedHashMap<>();
 public long cursor(){return sequence;}
 public void changeWorld(Object value){if(world!=value){world=value;recent.clear();deltas.clear();openedWindow=null;opened=null;}}
 public WindowRequest requestWindow(Object value,String target,long now){
  if(value==null||target==null||target.isBlank())throw new IllegalArgumentException("Missing requested window target");
  changeWorld(value);return new WindowRequest(value,target,sequence,now+3000);
 }
 public boolean confirmedWindow(WindowRequest request,Object value,Object screen,int handler,long now){
  if(request==null||request.world()!=value||now>request.deadline())return false;
  var receipt=windowAfter(value,screen,request.boundary());
  return receipt!=null&&receipt.handler()==handler&&receipt.target().equals(request.target());
 }
 public void recordWindow(Object value,Object screen,String target,int handler){
  if(value==null||screen==null)return;changeWorld(value);openedWindow=screen;opened=new WindowReceipt(++sequence,target,handler);
 }
 public WindowReceipt windowAfter(Object value,Object screen,long boundary){return world==value&&openedWindow==screen&&opened!=null&&opened.sequence()>boundary?opened:null;}
 public void record(Object value,int handler,int revision,List<String> slots,String cursor){
  if(value==null)return;changeWorld(value);recent.remove(handler);recent.put(handler,new Receipt(++sequence,revision,List.copyOf(slots),cursor));
  for(int i=0;i<slots.size();i++)remember(handler,i,slots.get(i));
  while(recent.size()>16)recent.remove(recent.keySet().iterator().next());
 }
 public Receipt after(Object value,int handler,long boundary){var row=world==value?recent.get(handler):null;return row!=null&&row.sequence>boundary?row:null;}
 private void remember(int handler,int slot,String value){var key=new Address(handler,slot);deltas.remove(key);deltas.put(key,new Delta(sequence,value));while(deltas.size()>2048)deltas.remove(deltas.keySet().iterator().next());}
 public void recordSlot(Object value,int handler,int slot,String stack){if(value==null||slot<0||slot>255)return;changeWorld(value);sequence++;remember(handler,slot,stack);}
 public Map<Integer,String> changes(Object value,int handler,long boundary){
  if(world!=value)return Map.of();var result=new HashMap<Integer,String>();
  deltas.forEach((key,delta)->{if(key.handler==handler&&delta.sequence>boundary)result.put(key.slot,delta.value);});return Map.copyOf(result);
 }
}
