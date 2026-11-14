package dev.momo.task;
public final class PickupMotionSmoke {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  var below=PickupMotion.swim(true,true,true,1,-3,1);
  check(below.steer()&&below.forward()&&below.down()&&!below.up(),"A visible nearby underwater drop needs diving, not a surface walking goal");
  var above=PickupMotion.swim(true,true,true,0,2,0);
  check(above.steer()&&!above.forward()&&above.up()&&!above.down(),"Float upward without unnecessary horizontal movement");
  check(!PickupMotion.swim(false,true,true,1,-3,1).steer(),"Land approaches remain with the navigator");
  check(!PickupMotion.swim(true,true,false,1,-3,1).steer(),"Do not dive after an unseen target");
  check(!PickupMotion.swim(true,true,true,9,0,0).steer(),"Local swimming cannot replace long-range collision navigation");
  check(!PickupMotion.swim(true,true,true,Double.NaN,0,0).steer(),"Invalid coordinates never press inputs");
  var near=PickupMotion.swim(true,true,true,.1,.1,.1);
  check(near.steer()&&!near.forward()&&!near.up()&&!near.down(),"Wait for the actual pickup receipt at contact instead of overshooting");
  System.out.println("PASS bounded visible underwater pickup steering");
 }
}
