// Return the distance between two latitude and longitude points in meters
// using the haversine formula
// http://www.movable-type.co.uk/scripts/latlong.html
function haversineDistance(lat1, lon1, lat2, lon2) {
  var R = 6371000; // radius of the earth in meters
  var dLat = deg2rad(lat2 - lat1);
  var dLon = deg2rad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  var d = R * c;
  return d;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180)
}

exports.haversineDistance = haversineDistance;
