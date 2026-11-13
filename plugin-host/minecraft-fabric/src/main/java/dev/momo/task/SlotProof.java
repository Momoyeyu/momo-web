package dev.momo.task;
import java.util.*;
/** Confirm the intended delta, never an unrelated station or backpack change. */
public final class SlotProof {
 private final List<String> before;private final String beforeCursor;
 private Map<Integer,String> expected=Map.of();private String cursor;private long boundary;private int tick;
 private Set<Integer> buttonSlots=Set.of();
 public SlotProof(List<String> before,String cursor){this.before=List.copyOf(before);beforeCursor=cursor;}
 public void buttonSlots(Set<Integer> slots){buttonSlots=Set.copyOf(slots);}
 public void mutated(int tick,long boundary,List<String> after,String cursor){
  this.tick=tick;this.boundary=boundary;this.cursor=cursor;var changes=new LinkedHashMap<Integer,String>();
  for(int i=0;i<Math.min(before.size(),after.size());i++)if(!before.get(i).equals(after.get(i)))changes.put(i,after.get(i));
  expected=Map.copyOf(changes);
 }
 public boolean settled(int now,InventoryReceipts.Receipt actual){
  if(actual==null||actual.sequence()<=boundary||now-tick<4||!Objects.equals(cursor,actual.cursor()))return false;
  for(var row:expected.entrySet())if(row.getKey()>=actual.slots().size()||!row.getValue().equals(actual.slots().get(row.getKey())))return false;
  if(!expected.isEmpty()||!Objects.equals(beforeCursor,cursor))return true;
  for(int slot:buttonSlots)if(slot<before.size()&&slot<actual.slots().size()&&!before.get(slot).equals(actual.slots().get(slot)))return true;
  return false;
 }
 public boolean settledButton(int now,Map<Integer,String> changes){
  if(now-tick<4)return false;
  for(int slot:buttonSlots)if(slot<before.size()&&changes.containsKey(slot)&&!before.get(slot).equals(changes.get(slot)))return true;
  return false;
 }
}
