package dev.momo.task;
import java.util.*;
/** Actual window input only; software KeyBinding changes never enter this state. */
public final class PhysicalInputState {
 public static boolean pointerMoved(boolean active,boolean resetting,double previousX,double previousY,double x,double y){
  return active&&!resetting&&Math.abs(x-previousX)+Math.abs(y-previousY)>.5;
 }
 public enum Kind {KEY,SCAN,MOUSE}
 private final Map<Kind,Set<Integer>> held=new EnumMap<>(Kind.class);
 private void record(Kind kind,int code,boolean down){
  if(code<0)return;
  var keys=held.computeIfAbsent(kind,ignored->new HashSet<>());
  if(down)keys.add(code);else keys.remove(code);
 }
 public void key(int key,int scan,boolean down){record(Kind.KEY,key,down);record(Kind.SCAN,scan,down);}
 public void button(int button,boolean down){record(Kind.MOUSE,button,down);}
 public boolean pressed(Kind kind,int code){return code>=0&&held.getOrDefault(kind,Set.of()).contains(code);}
 public void focusLost(){held.clear();}
}
