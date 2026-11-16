package dev.momo.task;
public final class PhysicalInputStateSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args){
  var raw=new PhysicalInputState();
  check(!PhysicalInputState.pointerMoved(true,false,427,240,427,240),"vanilla centers its own coordinates before GLFW recenter; that warp is not player motion");
  check(!PhysicalInputState.pointerMoved(true,true,12,34,427,240),"the first callback after lock/resize is discarded by vanilla too");
  check(PhysicalInputState.pointerMoved(true,false,427,240,429,241),"the very next ordinary mouse delta must still hand off immediately");
  check(!PhysicalInputState.pointerMoved(false,false,427,240,900,600),"inactive or unlocked UI movement is not gameplay takeover");

  raw.key(87,17,true);raw.button(0,true);
  // Software key cleanup is separate from actual GLFW events. The same raw
  // state is used to rebuild current bindings after the AI releases its keys.
  check(raw.pressed(PhysicalInputState.Kind.KEY,87)&&raw.pressed(PhysicalInputState.Kind.SCAN,17),"both logical and scancode custom bindings retain the player's held key");
  check(raw.pressed(PhysicalInputState.Kind.MOUSE,0),"a held mouse button survives software cleanup too");
  check(!raw.pressed(PhysicalInputState.Kind.KEY,65),"an AI-only direction cannot be invented as physical input");
  raw.key(87,17,false);raw.button(0,false);
  check(!raw.pressed(PhysicalInputState.Kind.KEY,87)&&!raw.pressed(PhysicalInputState.Kind.SCAN,17)&&!raw.pressed(PhysicalInputState.Kind.MOUSE,0),"a release before takeover cleanup must not be resurrected");
  raw.key(-1,33,true);check(raw.pressed(PhysicalInputState.Kind.SCAN,33)&&!raw.pressed(PhysicalInputState.Kind.KEY,-1),"unknown keysyms can still use a real scancode without inventing an unknown key");
  raw.focusLost();check(!raw.pressed(PhysicalInputState.Kind.SCAN,33),"focus loss clears keys whose release may happen in another application");
  System.out.println("PASS physical keyboard/mouse binding state survives only while actually held");
 }
}
