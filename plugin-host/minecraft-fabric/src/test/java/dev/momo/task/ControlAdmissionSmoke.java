package dev.momo.task;
public final class ControlAdmissionSmoke {
 static void check(String expected,String type,boolean focused,boolean paused,boolean takeover,boolean scene,boolean screen,boolean owned,boolean dead,String skill){
  if(!expected.equals(ControlAdmission.reject(type,focused,paused,takeover,scene,screen,owned,dead,skill)))throw new AssertionError("unsafe "+type+" admission");
 }
 public static void main(String[] args){
  ControlLifetimeSmoke.main(args);
  PhysicalInputStateSmoke.main(args);
  InteractionOutcomeSmoke.main(args);
  WindowReceiptsSmoke.main(args);
  if(!InteractionScreens.accepts(true,true,false,false)||!InteractionScreens.accepts(true,false,true,true))throw new AssertionError("Owned interactions include station screens and the actual bed outcome");
  if(InteractionScreens.accepts(false,true,false,false)||InteractionScreens.accepts(true,false,true,false)||InteractionScreens.accepts(true,false,false,true))throw new AssertionError("Unrelated menus and unrequested bed screens must remain manual");
  var runtime=new TaskRuntime();var body=new TaskRuntimeSmoke.Work();runtime.submit("body","wait",body,0,1000);
  if(!ControlAdmission.bodyConflict("play",runtime.active()).equals("BODY_BUSY"))throw new AssertionError("legacy input must have a known pre-dispatch rejection while semantic work is queued");
  runtime.tick(1);
  if(!ControlAdmission.bodyConflict("play",runtime.active()).equals("BODY_BUSY")||!runtime.snapshot("body").state().equals("running")||body.stops!=0)throw new AssertionError("a busy rejection must preserve the running task, not revoke the body as an unknown result");
  for(String type:new String[]{"observe","task","events","cancel","pause","stop","chat"})if(!ControlAdmission.bodyConflict(type,runtime.active()).isEmpty())throw new AssertionError("read, chat and explicit stop/pause must stay usable while busy");
  runtime.stop("requested");if(!ControlAdmission.bodyConflict("play",runtime.active()).isEmpty())throw new AssertionError("an idle body remains available for the UI fallback");
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
  if(!ControlAdmission.closeOnRelease(false,true,true,true)||ControlAdmission.closeOnRelease(true,true,true,true)||ControlAdmission.closeOnRelease(false,false,true,true)||ControlAdmission.closeOnRelease(false,true,false,true)||ControlAdmission.closeOnRelease(false,true,true,false))throw new AssertionError("release closes only our confirmed empty-cursor screen; manual takeover preserves it");
  System.out.println("PASS physical, foreground, scene and screen admission");
 }
}
