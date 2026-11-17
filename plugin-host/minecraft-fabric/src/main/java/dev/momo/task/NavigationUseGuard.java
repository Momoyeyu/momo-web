package dev.momo.task;
/** Scope navigation-only automatic use; ordinary skills and physical input remain independent. */
public final class NavigationUseGuard {
 public static final NavigationUseGuard CURRENT=new NavigationUseGuard();
 private Object owner;
 private boolean preserve;
 public void begin(Object token,boolean preserve){owner=token;this.preserve=preserve;}
 public void end(Object token){if(owner==token){owner=null;preserve=false;}}
 public boolean active(){return owner!=null&&preserve;}
 public boolean block(boolean automaticSource,boolean physicalPending,boolean passage){return active()&&automaticSource&&!physicalPending&&!passage;}
}
