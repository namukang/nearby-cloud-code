var utils = require("cloud/utils.js");

// Max distance between nearby users
// 150 meters =~ 0.1 miles =~ 2 minute walk
var NEARBY_DISTANCE = 150;

// Max distance to wave to a user
var WAVE_DISTANCE = NEARBY_DISTANCE * 2;

// Number of seconds before a location is considered stale
var LOCATION_STALE_AGE = 60 * 5;

var getDistance = function(user1, user2) {
  var user1Location = user1.get("location");
  var user2Location = user2.get("location");
  var distance = utils.haversineDistance(
    user1Location.latitude, user1Location.longitude,
    user2Location.latitude, user2Location.longitude);
  return distance;
};

// Return true if user1 and user2 are best friends
var isBestFriend = function(user1, user2) {
  var bestFriends = user1.get("bestFriends");
  if (bestFriends) {
    for (var i = 0; i < bestFriends.length; i++) {
      var bestFriend = bestFriends[i];
      if (bestFriend.id === user2.id) {
        return true;
      }
    }
  }
  return false;
};

// Return true if user1 blocked user2
var hasBlocked = function(user1, user2) {
  var blockedUsers = user1.get("blockedUsers");
  if (blockedUsers) {
    for (var i = 0; i < blockedUsers.length; i++) {
      var blockedUser = blockedUsers[i];
      if (blockedUser.id === user2.id) {
        return true;
      }
    }
  }
  return false;
};

Parse.Cloud.define("updateFriends", function(request, response) {
  Parse.Cloud.useMasterKey();
  var user = request.user;
  updateFriends(user).then(function() {
    response.success();
  }, function(error) {
    var message;
    if (error.type && error.code && error.message) {
      // Facebook error
      message = error.type + " (" + error.code + "): " + error.message;
    } else if (error.code && error.message) {
      // Parse error
      message = "(" + error.code + "): " + error.message;
    } else {
      message = error;
    }
    response.error(message);
  });
});

var updateFriends = function(user) {
  if (!user) {
    return Parse.Promise.error("Request does not have an associated user.");
  }

  var authData = user.get("authData");
  var accessToken = authData["facebook"]["access_token"];

  // Get Facebook friends
  return Parse.Cloud.httpRequest({
    url: "https://graph.facebook.com/me/friends",
    params: {
      access_token: accessToken,
      limit: 5000 // get all friends in one request
    }
  }).then(function(httpResponse) {
    var friends = httpResponse.data.data;
    var friendFbIds = friends.map(function(friend) { return friend.id });
    var friendQuery = new Parse.Query(Parse.User);
    friendQuery.containedIn("fbId", friendFbIds);
    return friendQuery.find();
  }, function(httpResponse) {
    var error = httpResponse.data.error;
    return Parse.Promise.error(error);
  }).then(function(friends) {
    var relation = user.relation("friends");
    for (var i = 0; i < friends.length; i++) {
      // Add friend as user's friend
      var friend = friends[i];
      relation.add(friend);

      // Add user as friend's friend
      var friendRelation = friend.relation("friends");
      friendRelation.add(user);
    }
    var saveFriends = Parse.Object.saveAll(friends);
    var saveUser = user.save();
    return Parse.Promise.when([saveFriends, saveUser]);
  });
};

var getNearbyFriendsQuery = function(user) {
  var relation = user.relation("friends");
  var friendQuery = relation.query();
  friendQuery.select("location", "name");
  // Don't include people who are hidden
  friendQuery.notEqualTo("hideLocation", true);
  // Don't include people who have blocked user
  friendQuery.notEqualTo("blockedUsers", user);
  // Don't include people who user has blocked
  var blockedUsers = user.get("blockedUsers");
  if (blockedUsers) {
    var blockedIds = blockedUsers.map(function(blockedUser) {
      return blockedUser.id;
    });
    friendQuery.notContainedIn("objectId", blockedIds);
  }
  return friendQuery;
};

var getBestFriendsQuery = function(user) {
  var bestFriendsQuery = new Parse.Query(Parse.User);
  var bestFriends = user.get("bestFriends");
  var bestFriendsIds = bestFriends.map(function(friend) {
    return friend.id
  });
  bestFriendsQuery.select("hideLocation", "location", "name", "firstName", "blockedUsers");
  bestFriendsQuery.containedIn("objectId", bestFriendsIds);
  // Don't include people who user has blocked
  var blockedUsers = user.get("blockedUsers");
  if (blockedUsers) {
    var blockedIds = blockedUsers.map(function(blockedUser) {
      return blockedUser.id;
    });
    bestFriendsQuery.notContainedIn("objectId", blockedIds);
  }
  return bestFriendsQuery;
};

// Send a silent notification to get new location is current data is stale
var requestUpdatedLocations = function(users) {
  for (var i = 0; i < users.length; i++) {
    var user = users[i];
    var hidden = user.get("hideLocation");
    if (!hidden) {
      var location = user.get("location");
      var locationAge;
      if (location) {
        var currentTimestamp = Date.now() / 1000; // convert from ms to seconds
        locationAge = currentTimestamp - location["timestamp"];
      }
      if (!location || locationAge > LOCATION_STALE_AGE) {
        var pushQuery = new Parse.Query(Parse.Installation);
        pushQuery.equalTo("user", user);

        Parse.Push.send({
          where: pushQuery,
          data: {
            "content-available": 1,
            type: "updateLocation"
          }
        }, {
          success: function() {
          },
          error: function(error) {
            response.error("Error: " + error.code + " " + error.message);
          }
        });
      }
    }
  }
};

Parse.Cloud.define("nearbyFriends", function(request, response) {
  var user = request.user;
  if (!user) {
    response.error("Request does not have an associated user.");
    return;
  }

  if (!user.get("location")) {
    response.error("User's location is not set.");
    return;
  }

  var friendsQuery = getNearbyFriendsQuery(user);
  friendsQuery.find({
    success: function(results) {
      var nearbyFriends = results.filter(function(friend) {
        return getDistance(user, friend) <= NEARBY_DISTANCE;
      });

      var bestFriends = user.get("bestFriends");
      if (bestFriends) {
        var bestFriendsQuery = getBestFriendsQuery(user);
        bestFriendsQuery.find({
          success: function(bestFriends) {
            // Filter out best friends in the nearbyFriends list
            bestFriends = bestFriends.filter(function(bestFriend) {
              for (var i = 0; i < nearbyFriends.length; i++) {
                var nearbyFriend = nearbyFriends[i];
                if (nearbyFriend.id === bestFriend.id) {
                  return false;
                }
              }
              return true;
            });

            // Remove locations from friends who are hidden or have blocked user
            var bestFriendsJSON = bestFriends.map(function(friend) {
              var friendJSON = friend.toJSON();
              friendJSON["__type"] = "Object";
              friendJSON["className"] = "_User";
              var hidden = friend.get("hideLocation");
              var blocked = hasBlocked(friend, user);
              if (hidden || blocked) {
                friendJSON["hideLocation"] = true;
                delete friendJSON["location"];
              }
              delete friendJSON["blockedUsers"];
              return friendJSON;
            });
            response.success({
              nearbyFriends: nearbyFriends,
              bestFriends: bestFriendsJSON
            });
            requestUpdatedLocations(nearbyFriends);
            requestUpdatedLocations(bestFriends);
          },
          error: function(error) {
            response.error("Error: " + error.code + " " + error.message);
          }
        });
      } else {
        response.success({
          nearbyFriends: nearbyFriends,
          bestFriends: []
        });
        requestUpdatedLocations(nearbyFriends);
      }
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});

Parse.Cloud.define("wave", function(request, response) {
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var message = request.params.message;
  if (!message) {
    message = "👋🏽";
  }
  var recipientId = request.params.recipientId;

  // Validate that sender is friends with recipient
  var relation = sender.relation("friends");
  var friendQuery = relation.query();
  friendQuery.equalTo("objectId", recipientId);
  friendQuery.find({
    success: function(results) {
      if (results.length === 0) {
        response.error("No friend found.");
        return;
      }

      var recipient = results[0];
      // Validate that recipient is not hidden
      var hidden = recipient.get("hideLocation") === true;
      // Validate that sender is within waving distance of recipient if they're not best friends
      var tooFar = !isBestFriend(sender, recipient) && getDistance(sender, recipient) > WAVE_DISTANCE;
      // Validate that recipient has not blocked sender
      var blocked = hasBlocked(recipient, sender);
      if (hidden || tooFar || blocked) {
        response.error(recipient.get("firstName") + " is no longer nearby.")
        return;
      }

      var pushQuery = new Parse.Query(Parse.Installation);
      pushQuery.equalTo("user", recipient);

      var pushMessage = sender.get("name") + ": " + message;
      Parse.Push.send({
        where: pushQuery,
        expiration_interval: 60 * 60 * 24, // 1 day
        data: {
          type: "wave",
          alert: pushMessage,
          sound: "default",
          senderId: sender.id,
          senderName: sender.get("name")
        }
      }, {
        success: function() {
          response.success();
        },
        error: function(error) {
          response.error("Error: " + error.code + " " + error.message);
        }
      });
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});

Parse.Cloud.define("addBestFriend", function(request, response) {
  Parse.Cloud.useMasterKey();
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var recipientId = request.params.recipientId;
  // Validate that sender is friends with recipient
  var relation = sender.relation("friends");
  var friendQuery = relation.query();
  friendQuery.equalTo("objectId", recipientId);
  friendQuery.find({
    success: function(results) {
      if (results.length === 0) {
        response.error("No friend found.");
        return;
      }

      var recipient = results[0];
      // Validate that sender is not already best friends with recipient
      if (isBestFriend(sender, recipient)) {
        response.error("You are already best friends.");
        return;
      }

      // Find existing best friend requests
      var BestFriendRequest = Parse.Object.extend("BestFriendRequest");
      var requestFromSenderQuery = new Parse.Query(BestFriendRequest);
      requestFromSenderQuery.equalTo("fromUser", sender);
      requestFromSenderQuery.equalTo("toUser", recipient);
      var requestToSenderQuery = new Parse.Query(BestFriendRequest);
      requestToSenderQuery.equalTo("fromUser", recipient);
      requestToSenderQuery.equalTo("toUser", sender);
      var query = Parse.Query.or(requestFromSenderQuery, requestToSenderQuery);
      query.find({
        success: function(results) {
          if (results.length > 0) {
            var bestFriendRequest = results[0];
            var userSentRequest = bestFriendRequest.get("fromUser").id === sender.id;
            if (userSentRequest) {
              response.error("You have already sent a best friend request.");
            } else {
              // Accept best friend request
              bestFriendRequest.destroy();
              recipient.addUnique("bestFriends", sender);
              recipient.save();
              sender.addUnique("bestFriends", recipient);
              sender.save(null, {
                success: function(sender) {
                  response.success();
                },
                error: function(error) {
                  response.error("Error: " + error.code + " " + error.message);
                }
              });
            }
          } else {
            var bestFriendRequest = new BestFriendRequest()
            bestFriendRequest.set("fromUser", sender);
            bestFriendRequest.set("toUser", recipient);
            bestFriendRequest.save();

            var pushQuery = new Parse.Query(Parse.Installation);
            pushQuery.equalTo("user", recipient);

            Parse.Push.send({
              where: pushQuery,
              data: {
                type: "bestFriendRequest",
                alert: sender.get("name") + " added you as a best friend.",
                sound: "default"
              }
            }, {
              success: function() {
                response.success();
              },
              error: function(error) {
                response.error("Error: " + error.code + " " + error.message);
              }
            });
          }
        },
        error: function(error) {
          response.error("Error: " + error.code + " " + error.message);
        }
      });
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});

Parse.Cloud.define("removeBestFriendRequest", function(request, response) {
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var recipientId = request.params.recipientId;
  var recipient = new Parse.User();
  recipient.id = recipientId;

  // Find existing best friend requests
  var BestFriendRequest = Parse.Object.extend("BestFriendRequest");
  var requestFromSenderQuery = new Parse.Query(BestFriendRequest);
  requestFromSenderQuery.equalTo("fromUser", sender);
  requestFromSenderQuery.equalTo("toUser", recipient);
  var requestToSenderQuery = new Parse.Query(BestFriendRequest);
  requestToSenderQuery.equalTo("fromUser", recipient);
  requestToSenderQuery.equalTo("toUser", sender);
  var query = Parse.Query.or(requestFromSenderQuery, requestToSenderQuery);
  query.find({
    success: function(results) {
      if (results.length > 0) {
        var bestFriendRequest = results[0];
        bestFriendRequest.destroy();
        response.success();
      } else {
        response.error("No best friend request found.");
      }
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});

Parse.Cloud.define("removeBestFriend", function(request, response) {
  Parse.Cloud.useMasterKey();
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var recipientId = request.params.recipientId;
  var recipient = new Parse.User();
  recipient.id = recipientId;

  var bf = isBestFriend(sender, recipient);

  recipient.remove("bestFriends", sender);
  recipient.save();
  sender.remove("bestFriends", recipient);
  sender.save(null, {
    success: function(sender) {
      response.success();
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});
