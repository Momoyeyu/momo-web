package dev.momo.task;
public final class ControlAdmissionSmoke {
 static void check(String expected,String type,boolean focused,boolean paused,boolean takeover,boolean scene,boolean screen,boolean owned,boolean dead,String skill){
  if(!expected.equals(ControlAdmission.reject(type,focused,paused,takeover,scene,screen,owned,dead,skill)))throw new AssertionError("unsafe "+type+" admission");
 }
 public static void main(String[] args){
  for(String type:new String[]{"submit","play","follow","chat"}){
   check("BODY_PAUSED",type,true,true,false,false,false,false,false,"");
   check("BODY_PAUSED",type,true,false,true,false,false,false,false,"");
   check("BODY_SUSPENDED",type,false,false,false,false,false,false,false,"");
   check("SCENE_OBSERVATION_REQUIRED",type,true,false,false,true,false,false,false,"");
   check("MENU_OPEN",type,true,false,false,false,true,false,false,"");
  }
  check("","submit",true,false,false,false,true,true,false,"inventory");
  check("","submit",true,false,false,false,true,false,true,"respawn");
  check("DEAD_REPLAN","submit",true,false,false,false,true,false,true,"place");
  check("","observe",false,true,true,true,true,false,true,"");
  System.out.println("PASS physical, foreground, scene and screen admission");
 }
}
