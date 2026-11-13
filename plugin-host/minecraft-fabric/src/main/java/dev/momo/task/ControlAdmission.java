package dev.momo.task;
import java.util.Set;
/** Checked on the game thread, immediately before any world/UI mutation. */
public final class ControlAdmission {
 private static final Set<String> MUTATIONS=Set.of("submit","play","follow","chat");
 public static String reject(String type,boolean focused,boolean paused,boolean takeover,boolean sceneChanged,boolean screen,boolean owned,boolean dead,String skill){
  if(!MUTATIONS.contains(type))return "";
  if(paused||takeover)return "BODY_PAUSED";
  if(sceneChanged)return "SCENE_OBSERVATION_REQUIRED";
  if(!focused)return "BODY_SUSPENDED";
  if(dead)return type.equals("submit")&&skill.equals("respawn")?"":"DEAD_REPLAN";
  return screen&&!owned?"MENU_OPEN":"";
 }
}
