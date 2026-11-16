package dev.momo.task;
import java.util.*;
/** Main inventory indices are not screen output slots or hotbar button numbers. */
public final class ItemSelection {
 public record Choice(int inventory,int hotbar){public int screenSlot(){return inventory<9?36+inventory:inventory;}public boolean swap(){return inventory!=hotbar;}}
 public record OutputSlot(int slot,boolean main,boolean insert,boolean compatible,int count,int limit){}
 private ItemSelection(){}
 public static Optional<Choice> choose(List<Integer> matches,int preferred,int selected){
  if(preferred< -1||preferred>8||selected<0||selected>8||matches.stream().anyMatch(i->i<0||i>35))throw new IllegalArgumentException("Invalid inventory selection");
  if(matches.isEmpty())return Optional.empty();
  int target=preferred>=0?preferred:selected;
  int source=matches.contains(target)?target:matches.stream().min(Integer::compareTo).orElseThrow();
  if(preferred<0&&source<9)target=source;
  return Optional.of(new Choice(source,target));
 }
 public static OptionalInt output(List<OutputSlot> slots,int amount){
  if(amount<=0)return OptionalInt.empty();
  var fitting=slots.stream().filter(s->s.main()&&s.insert()&&s.count()>=0&&s.count()+amount<=s.limit()).toList();
  var destination=fitting.stream().filter(s->s.count()>0&&s.compatible()).findFirst();
  if(destination.isEmpty())destination=fitting.stream().filter(s->s.count()==0).findFirst();
  return destination.isPresent()?OptionalInt.of(destination.get().slot()):OptionalInt.empty();
 }
}
