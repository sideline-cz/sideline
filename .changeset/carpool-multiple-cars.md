---
"@sideline/server": patch
---

fix(carpool): prevent a member from being in multiple cars at once

The owner of one car could also reserve or be assigned a passenger seat in another car of the same carpool, ending up in two cars. `reserveSeat` now rejects a member who already owns a car in the carpool (`CarpoolAlreadyInAnotherCar`), and `reserveSeat`/`removeCar` take a `FOR UPDATE` lock on the shared carpool row — matching `addCar` — to also close a concurrent `addCar` + `reserveSeat` race that could bypass the check.
