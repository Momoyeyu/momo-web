package dev.momo.task;
/** Only an actual outcome of our interaction becomes an owned screen. */
final class InteractionScreens {
 static boolean accepts(boolean acted,boolean handled,boolean sleepingScreen,boolean sleepingPlayer){return acted&&(handled||sleepingScreen&&sleepingPlayer);}
}
