package dev.momo.task;
import java.util.LinkedHashSet;
/** Activity-local hysteresis after a completed retreat, never permission or an objective. */
final class RetreatMemory {
 private final LinkedHashSet<Integer> escaped=new LinkedHashSet<>();
 private float previous=Float.NaN;private Object damage;
 void health(float value){if(value>6||Float.isFinite(previous)&&value<previous-.01f)escaped.clear();previous=value;}
 void damage(Object value){if(value!=null&&value!=damage)escaped.clear();damage=value;}
 void reachedSafety(int entity){escaped.remove(entity);escaped.add(entity);while(escaped.size()>16)escaped.remove(escaped.iterator().next());}
 boolean defer(int entity,double distanceSquared){
  if(!Double.isFinite(distanceSquared)||distanceSquared<81){escaped.remove(entity);return false;}
  return escaped.contains(entity);
 }
 void clear(){escaped.clear();previous=Float.NaN;damage=null;}
}
