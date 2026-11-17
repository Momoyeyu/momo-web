package dev.momo.task;
import java.util.Map;
/** Coarse natural-sky/owned-clock knowledge, never a hidden world clock. */
final class DaylightState {
 static Map<String,Object> observe(boolean natural,boolean skyVisible,boolean clock,long daylightTime){
  if(!natural)return Map.of("phase","unknown","source","none","reason","no_daylight_cycle");
  if(!skyVisible&&!clock)return Map.of("phase","unknown","source","none","reason","sky_occluded");
  long time=Math.floorMod(daylightTime,24000);
  String phase=time<12000?"day":time<13000?"sunset":time<23000?"night":"dawn";
  return Map.of("phase",phase,"source",skyVisible?"sky":"clock");
 }
}
