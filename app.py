import os
from flask import Flask, render_template, request, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash
import uuid

# Initialize Flask app
app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize extensions
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
socketio = SocketIO(app, cors_allowed_origins="*")

# Database Models
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)
    contacts = db.relationship('Contact', backref='user', lazy=True)

class Contact(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120))
    phone = db.Column(db.String(20))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)

# Active call rooms
active_rooms = {}

# User loader
@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# Routes
@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return render_template('index.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        email = request.form['email']
        password = request.form['password']
        
        if User.query.filter_by(username=username).first():
            flash('Username already exists')
            return redirect(url_for('register'))
        
        if User.query.filter_by(email=email).first():
            flash('Email already exists')
            return redirect(url_for('register'))
        
        hashed_password = generate_password_hash(password)
        new_user = User(username=username, email=email, password=hashed_password)
        db.session.add(new_user)
        db.session.commit()
        
        flash('Registration successful. Please login.')
        return redirect(url_for('login'))
    
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        user = User.query.filter_by(username=username).first()
        
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('dashboard'))
        else:
            flash('Invalid username or password')
    
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))

@app.route('/dashboard')
@login_required
def dashboard():
    return render_template('dashboard.html')

@app.route('/contacts')
@login_required
def contacts():
    user_contacts = Contact.query.filter_by(user_id=current_user.id).all()
    return render_template('contacts.html', contacts=user_contacts)

@app.route('/add_contact', methods=['GET', 'POST'])
@login_required
def add_contact():
    if request.method == 'POST':
        name = request.form['name']
        email = request.form['email']
        phone = request.form['phone']
        
        new_contact = Contact(name=name, email=email, phone=phone, user_id=current_user.id)
        db.session.add(new_contact)
        db.session.commit()
        
        flash('Contact added successfully')
        return redirect(url_for('contacts'))
    
    return render_template('add_contact.html')

@app.route('/edit_contact/<int:contact_id>', methods=['GET', 'POST'])
@login_required
def edit_contact(contact_id):
    contact = Contact.query.get_or_404(contact_id)
    
    if contact.user_id != current_user.id:
        flash('You are not authorized to edit this contact')
        return redirect(url_for('contacts'))
    
    if request.method == 'POST':
        contact.name = request.form['name']
        contact.email = request.form['email']
        contact.phone = request.form['phone']
        
        db.session.commit()
        flash('Contact updated successfully')
        return redirect(url_for('contacts'))
    
    return render_template('edit_contact.html', contact=contact)

@app.route('/delete_contact/<int:contact_id>')
@login_required
def delete_contact(contact_id):
    contact = Contact.query.get_or_404(contact_id)
    
    if contact.user_id != current_user.id:
        flash('You are not authorized to delete this contact')
        return redirect(url_for('contacts'))
    
    db.session.delete(contact)
    db.session.commit()
    flash('Contact deleted successfully')
    return redirect(url_for('contacts'))

@app.route('/call')
@login_required
def call():
    room_code = request.args.get('room')
    if not room_code:
        room_code = str(uuid.uuid4())[:8]
        return redirect(url_for('call', room=room_code))
    
    return render_template('call.html', room=room_code)

# Socket.IO events
@socketio.on('join_room')
def handle_join_room(data):
    room = data['room']
    join_room(room)
    
    if room not in active_rooms:
        active_rooms[room] = {'users': [], 'messages': []}
    
    if current_user.username not in active_rooms[room]['users']:
        active_rooms[room]['users'].append(current_user.username)
    
    emit('user_joined', {'username': current_user.username, 'users': active_rooms[room]['users']}, room=room)
    emit('message_history', {'messages': active_rooms[room]['messages']})

@socketio.on('leave_room')
def handle_leave_room(data):
    room = data['room']
    leave_room(room)
    
    if room in active_rooms and current_user.username in active_rooms[room]['users']:
        active_rooms[room]['users'].remove(current_user.username)
        
        # If room is empty, remove it after a delay
        if not active_rooms[room]['users']:
            # We'll keep the room for a while in case someone wants to rejoin
            pass
    
    emit('user_left', {'username': current_user.username, 'users': active_rooms[room]['users'] if room in active_rooms else []}, room=room)

@socketio.on('send_message')
def handle_send_message(data):
    room = data['room']
    message = {
        'username': current_user.username,
        'message': data['message'],
        'timestamp': data['timestamp']
    }
    
    if room in active_rooms:
        active_rooms[room]['messages'].append(message)
    
    emit('receive_message', message, room=room)

@socketio.on('webrtc_offer')
def handle_webrtc_offer(data):
    emit('webrtc_offer', {
        'offer': data['offer'],
        'username': current_user.username
    }, room=data['room'], include_self=False)

@socketio.on('webrtc_answer')
def handle_webrtc_answer(data):
    emit('webrtc_answer', {
        'answer': data['answer'],
        'username': current_user.username
    }, room=data['room'], include_self=False)

@socketio.on('ice_candidate')
def handle_ice_candidate(data):
    emit('ice_candidate', {
        'candidate': data['candidate'],
        'username': current_user.username
    }, room=data['room'], include_self=False)

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, host='0.0.0.0', port=5001, debug=True)
