package dev.momo.task;
import java.util.*;
/** Player-visible messages only, with bounded storage and no instruction authority. */
public final class GameChat {
 public static final GameChat CURRENT=new GameChat();
 public record Message(long seq,long receivedAt,String kind,String text,String sender,boolean self){}
 public record Snapshot(long cursor,long externalCursor,boolean untrusted,List<Message> messages){}
 private Object world;private long sequence,external;private final ArrayDeque<Message> messages=new ArrayDeque<>();
 public void scene(Object current){if(world!=current){world=current;messages.clear();external=0;}}
 private static String bounded(String value,int limit){return value==null?"":value.codePoints().limit(limit).collect(StringBuilder::new,StringBuilder::appendCodePoint,StringBuilder::append).toString();}
 public void receive(Object current,String kind,String text,String sender,boolean self,long receivedAt){
  scene(current);if(current==null||text==null||text.isBlank()||!Set.of("player","system","overlay").contains(kind))return;
  var row=new Message(++sequence,receivedAt,kind,bounded(text,1024),bounded(sender,128),self);messages.add(row);
  if(kind.equals("player")&&!self)external=row.seq();
  if(messages.stream().filter(m->m.kind().equals("player")).count()>24)messages.remove(messages.stream().filter(m->m.kind().equals("player")).findFirst().orElseThrow());
  while(messages.size()>32)messages.remove(messages.stream().filter(m->!m.kind().equals("player")).findFirst().orElse(messages.getFirst()));
 }
 public Snapshot snapshot(Object current){scene(current);return new Snapshot(sequence,external,true,List.copyOf(messages));}
 public Map<String,Object> notification(Object current){var view=snapshot(current);return Map.of("cursor",view.cursor(),"externalCursor",view.externalCursor(),"untrusted",true);}
}
